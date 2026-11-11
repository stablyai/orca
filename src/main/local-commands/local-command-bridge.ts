import {
  LOCAL_COMMAND_APPROVAL_WINDOW_MS,
  hasNonAsciiCharacters,
  type LocalCommandDeclineReason,
  type LocalCommandSettleParams,
  type LocalCommandSettleResult
} from '../../shared/local-commands/local-command-contract'
import type {
  LocalCommandAuditEntry,
  LocalCommandDecision,
  LocalCommandPrompt
} from '../../shared/local-commands/local-command-desktop-types'
import { createLocalCommandAttachments, type LocalCommandTimer } from './local-command-attachments'
import type { LocalCommandBridgeDeps } from './local-command-bridge-types'
import {
  LocalCommandRequestedEventSchema,
  LocalCommandSettledEventSchema,
  displayText,
  requestIdOf
} from './local-command-request-checks'
import { createLocalCommandWorkspacePolicy } from './local-command-workspace-policy'
import { runApprovedLocalCommand, type RequestBase } from './local-command-run'
import {
  LOCAL_COMMAND_DESKTOP_LIMITS,
  createLocalCommandRequestLimits
} from './local-command-request-limits'

export type { LocalCloudWorkspaceRef, LocalCommandBridgeDeps } from './local-command-bridge-types'

/** A person can't have read a prompt this fresh: an allow that lands sooner is refused. */
export const LOCAL_COMMAND_MIN_DECISION_MS = 600
const HANDLED_LIMIT = 500

type PendingPrompt = {
  prompt: LocalCommandPrompt
  environmentId: string
  shownAt: number
  timer: { cancel: () => void }
}

const defaultTimer: LocalCommandTimer = (run, ms) => {
  const handle = setTimeout(run, ms)
  handle.unref?.()
  return { cancel: () => clearTimeout(handle) }
}

/**
 * This computer's side of local commands: attaches to each cloud workspace the person turned on,
 * re-checks every request against its own rules, asks the person, runs and reports, and records
 * everything in the audit log. Nothing here acts on the VM's say-so alone.
 */
export function createLocalCommandBridge(deps: LocalCommandBridgeDeps) {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? defaultTimer
  const log = deps.log ?? ((message: string) => console.info(`[local-commands] ${message}`))
  const pending = new Map<string, PendingPrompt>()
  // Environment + request ids this computer already acted on; a replay is never answered twice.
  const handled = new Set<string>()
  const limits = createLocalCommandRequestLimits()
  // The prompt in front and since when: a queued one gets its own read delay when it moves up.
  let front: { id: string; since: number } | null = null
  const policy = createLocalCommandWorkspacePolicy({ ...deps, now })
  const { labelOf, policyOf, refusalOf } = policy
  const attachments = createLocalCommandAttachments({
    subscribe: deps.subscribe,
    setTimer,
    onConnectedChanged: deps.publishState,
    onEvent: (sandboxId, environmentId, event) => {
      const type = (event as { type?: unknown }).type
      if (type === 'requested') {
        void onRequested(environmentId, sandboxId, event)
      } else if (type === 'settled') {
        onSettled(environmentId, event)
      }
    }
  })

  function audit(entry: Omit<LocalCommandAuditEntry, 'at' | 'workspaceLabel'>): void {
    deps.audit.append({ at: now(), workspaceLabel: labelOf(entry.sandboxId), ...entry })
  }

  function publishPrompts(): void {
    const prompts = [...pending.values()].map((p) => p.prompt)
    const firstId = prompts[0]?.id ?? null
    if (firstId !== front?.id) {
      front = firstId ? { id: firstId, since: now() } : null
    }
    deps.publishPrompts(prompts)
  }

  /** Refused without asking; a flood of refusals is logged once a minute. */
  function refuse(environmentId: string, base: RequestBase, detail: string): void {
    if (limits.shouldLogRefusal(base.sandboxId, now())) {
      audit({ ...base, command: base.command.slice(0, 1000), outcome: 'refused', detail })
    }
    decline(environmentId, base.requestId, 'not_allowed')
  }

  async function settle(
    environmentId: string,
    params: LocalCommandSettleParams
  ): Promise<LocalCommandSettleResult | null> {
    try {
      return await deps.settle(environmentId, params)
    } catch (error) {
      log(`settle ${params.outcome} failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  function decline(environmentId: string, requestId: string, reason: LocalCommandDeclineReason) {
    void settle(environmentId, { requestId, outcome: 'declined', reason })
  }

  async function onRequested(environmentId: string, sandboxId: string, raw: unknown) {
    const requestId = requestIdOf(raw)
    const key = `${environmentId}\0${requestId}`
    if (!requestId || handled.has(key) || pending.has(requestId)) {
      return
    }
    handled.add(key)
    if (handled.size > HANDLED_LIMIT) {
      handled.delete(handled.values().next().value!)
    }
    const parsed = LocalCommandRequestedEventSchema.safeParse(raw)
    if (!parsed.success) {
      const blank = { requestId, sandboxId, command: '', cwd: null, agent: null }
      refuse(environmentId, blank, 'The request was malformed or had hidden characters.')
      return
    }
    const event = parsed.data
    const base: RequestBase = {
      requestId,
      sandboxId,
      command: event.command,
      cwd: event.cwd,
      agent: displayText(event.agent, 64)
    }
    const waiting = [...pending.values()].filter((p) => p.prompt.sandboxId === sandboxId).length
    if (
      waiting >= LOCAL_COMMAND_DESKTOP_LIMITS.pendingPerWorkspace ||
      !limits.admitRequest(sandboxId, now())
    ) {
      refuse(environmentId, base, 'Too many requests from this workspace.')
      return
    }
    const refusal = await refusalOf(sandboxId)
    if (refusal) {
      refuse(environmentId, base, refusal)
      return
    }
    const cwd = await deps.resolveCwd(event.cwd)
    if (!cwd) {
      refuse(environmentId, base, 'The folder does not exist on this computer.')
      return
    }
    if (
      deps.settings.findRule(sandboxId, event.command, cwd, now()) &&
      limits.admitAutoRun(sandboxId, now())
    ) {
      await runApproved(environmentId, { ...base, cwd }, event.timeoutSec, 'auto-allowed')
      return
    }
    const windowMs = Math.min(event.expiresInMs, LOCAL_COMMAND_APPROVAL_WINDOW_MS)
    if (windowMs <= 0) {
      return
    }
    const prompt: LocalCommandPrompt = {
      id: requestId,
      sandboxId,
      workspaceLabel: labelOf(sandboxId),
      shared: policy.cached(sandboxId)?.shared ?? false,
      command: event.command,
      cwd,
      timeoutSec: event.timeoutSec,
      reason: displayText(event.reason, 200),
      agent: base.agent,
      hasNonAscii: hasNonAsciiCharacters(event.command) || hasNonAsciiCharacters(cwd),
      expiresAt: now() + windowMs
    }
    const timer = setTimer(() => {
      if (pending.delete(requestId)) {
        audit({ ...base, cwd, outcome: 'timed-out' })
        decline(environmentId, requestId, 'approval_timed_out')
        publishPrompts()
      }
    }, windowMs)
    const firstWaiting = pending.size === 0
    pending.set(requestId, { prompt, environmentId, shownAt: now(), timer })
    publishPrompts()
    // One banner per burst: further prompts queue behind the first.
    if (firstWaiting) {
      deps.onPromptAdded?.(prompt)
    }
  }

  const runApproved = (
    environmentId: string,
    base: RequestBase & { cwd: string },
    timeoutSec: number,
    outcome: 'allowed-once' | 'always-allowed' | 'auto-allowed'
  ): Promise<void> => {
    limits.runStarted(base.sandboxId)
    return runApprovedLocalCommand(
      { settle, execute: deps.execute, audit },
      environmentId,
      base,
      timeoutSec,
      outcome
    ).finally(() => limits.runEnded(base.sandboxId))
  }

  function closePrompt(id: string, entry: PendingPrompt): RequestBase & { cwd: string } {
    entry.timer.cancel()
    pending.delete(id)
    publishPrompts()
    const { prompt } = entry
    return {
      requestId: id,
      sandboxId: prompt.sandboxId,
      command: prompt.command,
      cwd: prompt.cwd,
      agent: prompt.agent
    }
  }

  function onSettled(environmentId: string, raw: unknown): void {
    const parsed = LocalCommandSettledEventSchema.safeParse(raw)
    const entry = parsed.success ? pending.get(parsed.data.requestId) : undefined
    // Only the workspace that asked can close its own prompt.
    if (!parsed.success || !entry || entry.environmentId !== environmentId) {
      return
    }
    const base = closePrompt(parsed.data.requestId, entry)
    audit({
      ...base,
      outcome: parsed.data.status === 'expired' ? 'timed-out' : 'closed',
      detail: `The workspace reported it ${parsed.data.status}.`
    })
  }

  function reconcile(): void {
    const enabled = new Set(deps.supported ? deps.settings.enabledSandboxIds() : [])
    const desired = new Map<string, string>()
    for (const workspace of deps.listWorkspaces()) {
      policy.noteFallbackLabel(workspace.sandboxId, workspace.fallbackLabel)
      if (enabled.has(workspace.sandboxId) && workspace.runtimeEnvironmentId) {
        desired.set(workspace.sandboxId, workspace.runtimeEnvironmentId)
      }
    }
    attachments.reconcile(desired)
  }

  return {
    reconcile,
    labelOf,
    policyOf,
    isConnected: (sandboxId: string) => attachments.isConnected(sandboxId),

    async decide(
      id: string,
      decision: LocalCommandDecision
    ): Promise<{ ok: boolean; error?: string }> {
      const entry = pending.get(id)
      if (!entry) {
        return { ok: false, error: 'not_found' }
      }
      const visibleSince = front?.id === id ? front.since : now()
      if (decision !== 'deny' && now() - visibleSince < LOCAL_COMMAND_MIN_DECISION_MS) {
        return { ok: false, error: 'too_soon' }
      }
      const base = closePrompt(id, entry)
      if (decision === 'deny') {
        audit({ ...base, outcome: 'denied' })
        decline(entry.environmentId, id, 'denied')
        return { ok: true }
      }
      // Turned off (or ownership changed) while the prompt was open: the earlier check is stale.
      const refusal = await refusalOf(base.sandboxId)
      if (refusal) {
        audit({ ...base, outcome: 'refused', detail: refusal })
        decline(entry.environmentId, id, 'not_allowed')
        return { ok: false, error: 'not_allowed' }
      }
      if (decision === 'always-allow') {
        deps.settings.addRule(base.sandboxId, base.command, base.cwd, now())
        deps.publishState()
      }
      const outcome = decision === 'always-allow' ? 'always-allowed' : 'allowed-once'
      void runApproved(entry.environmentId, base, entry.prompt.timeoutSec, outcome)
      return { ok: true }
    },

    prompts: (): LocalCommandPrompt[] => [...pending.values()].map((p) => p.prompt),

    /** Turning a workspace off answers its open prompts as refused. */
    dropPromptsFor(sandboxId: string): void {
      for (const [id, entry] of pending) {
        if (entry.prompt.sandboxId === sandboxId) {
          const base = closePrompt(id, entry)
          audit({ ...base, outcome: 'refused', detail: 'Local commands were turned off.' })
          decline(entry.environmentId, id, 'not_allowed')
        }
      }
    },

    dispose(): void {
      attachments.dispose()
      for (const entry of pending.values()) {
        entry.timer.cancel()
      }
      pending.clear()
    }
  }
}

export type LocalCommandBridge = ReturnType<typeof createLocalCommandBridge>
