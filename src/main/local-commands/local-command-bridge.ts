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
  localCommandRefusal,
  requestIdOf,
  type LocalCommandWorkspacePolicy
} from './local-command-request-checks'
import { runApprovedLocalCommand, type RequestBase } from './local-command-run'

export type { LocalCloudWorkspaceRef, LocalCommandBridgeDeps } from './local-command-bridge-types'

/** A person can't have read a prompt this fresh: an allow that lands sooner is refused. */
export const LOCAL_COMMAND_MIN_DECISION_MS = 600
const POLICY_TTL_MS = 30_000
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
  // Request ids this computer already acted on; a replay after reconnect is never answered twice.
  const handled = new Set<string>()
  const policyCache = new Map<string, { at: number; value: LocalCommandWorkspacePolicy | null }>()
  const labels = new Map<string, string>()
  const attachments = createLocalCommandAttachments({
    subscribe: deps.subscribe,
    setTimer,
    onConnectedChanged: deps.publishState,
    onEvent: (sandboxId, environmentId, event) => {
      const type = (event as { type?: unknown }).type
      if (type === 'requested') {
        void onRequested(environmentId, sandboxId, event)
      } else if (type === 'settled') {
        onSettled(event)
      }
    }
  })

  const labelOf = (sandboxId: string): string => labels.get(sandboxId) ?? sandboxId

  function audit(entry: Omit<LocalCommandAuditEntry, 'at' | 'workspaceLabel'>): void {
    deps.audit.append({ at: now(), workspaceLabel: labelOf(entry.sandboxId), ...entry })
  }

  function publishPrompts(): void {
    deps.publishPrompts([...pending.values()].map((p) => p.prompt))
  }

  async function policyOf(
    sandboxId: string,
    fresh: boolean
  ): Promise<LocalCommandWorkspacePolicy | null> {
    const cached = policyCache.get(sandboxId)
    if (!fresh && cached && now() - cached.at < POLICY_TTL_MS) {
      return cached.value
    }
    const value = await deps.readPolicy(sandboxId).catch(() => null)
    policyCache.set(sandboxId, { at: now(), value })
    if (value?.title) {
      labels.set(sandboxId, value.title)
    }
    return value
  }

  async function refusalOf(sandboxId: string): Promise<string | null> {
    const setting = deps.settings.workspace(sandboxId)
    if (!deps.supported || !setting?.enabled) {
      return localCommandRefusal(deps.supported, setting, null)
    }
    return localCommandRefusal(deps.supported, setting, await policyOf(sandboxId, true))
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
    if (!requestId || handled.has(requestId) || pending.has(requestId)) {
      return
    }
    handled.add(requestId)
    if (handled.size > HANDLED_LIMIT) {
      handled.delete(handled.values().next().value!)
    }
    const parsed = LocalCommandRequestedEventSchema.safeParse(raw)
    if (!parsed.success) {
      audit({ requestId, sandboxId, command: '', cwd: null, agent: null, outcome: 'refused' })
      decline(environmentId, requestId, 'not_allowed')
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
    const refusal = await refusalOf(sandboxId)
    if (refusal) {
      audit({ ...base, outcome: 'refused', detail: refusal })
      decline(environmentId, requestId, 'not_allowed')
      return
    }
    const cwd = await deps.resolveCwd(event.cwd)
    if (!cwd) {
      audit({ ...base, outcome: 'refused', detail: 'The folder does not exist on this computer.' })
      if ((await settle(environmentId, { requestId, outcome: 'started' }))?.accepted) {
        await settle(environmentId, {
          requestId,
          outcome: 'failed',
          message: `The folder ${event.cwd ?? '~'} does not exist on the person's computer.`
        })
      }
      return
    }
    if (deps.settings.findRule(sandboxId, event.command, cwd)) {
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
      shared: policyCache.get(sandboxId)?.value?.shared ?? false,
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
    pending.set(requestId, { prompt, environmentId, shownAt: now(), timer })
    publishPrompts()
    deps.onPromptAdded?.(prompt)
  }

  const runApproved = (
    environmentId: string,
    base: RequestBase & { cwd: string },
    timeoutSec: number,
    outcome: 'allowed-once' | 'always-allowed' | 'auto-allowed'
  ): Promise<void> =>
    runApprovedLocalCommand(
      { settle, execute: deps.execute, audit },
      environmentId,
      base,
      timeoutSec,
      outcome
    )

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

  function onSettled(raw: unknown): void {
    const parsed = LocalCommandSettledEventSchema.safeParse(raw)
    const entry = parsed.success ? pending.get(parsed.data.requestId) : undefined
    if (!parsed.success || !entry) {
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
      if (!labels.has(workspace.sandboxId)) {
        labels.set(workspace.sandboxId, workspace.fallbackLabel)
      }
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
      if (decision !== 'deny' && now() - entry.shownAt < LOCAL_COMMAND_MIN_DECISION_MS) {
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
