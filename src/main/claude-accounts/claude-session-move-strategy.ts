import type { AgentProviderSessionMetadata } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { ClaudePaneAccountRecord } from './claude-pane-account-registry'
import type { AgentStartupSettings } from '../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { buildAgentResumeStartupPlan } from '../../shared/agent-launch/startup/tui-agent-resume-startup'
import { resolveStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { RuntimePtyController } from '../runtime/runtime-pty-controller-contract'
import {
  deliverClaudeSessionMoveHandoff,
  type ClaudeSessionMoveHandoff
} from './claude-session-move-handoff'
import {
  claudeResumeHookBaseline,
  type ClaudeSessionMoveEndedWork,
  type ClaudeSessionMoveHandoffTranslate
} from './claude-session-move-handoff-note'

export type ClaudeSessionMoveRequest = {
  ptyId: string
  paneKey: string
  worktreeId: string
  connectionId: string | null
  toAccountId: string
  providerSession: AgentProviderSessionMetadata
  /** Pre-move hook facts. Present only when the mover is asking for the handoff note. */
  handoff?: ClaudeSessionMoveHandoff
}

export type ClaudeSessionMoveOutcome =
  | {
      kind: 'moved'
      newPtyId: string
      endedWork?: ClaudeSessionMoveEndedWork
      handoffNote?: 'sent' | 'unsent'
    }
  | { kind: 'skipped'; reason: 'no-controller' | 'no-resume-plan' | 'no-pane' }
  | { kind: 'failed'; reason: 'owner-changed' | 'spawn-failed'; error: string }

/** How a session gets onto another account. `resume` restarts it; `proxy` flips the slot and keeps the PTY. */
export type ClaudeSessionMoveStrategy = {
  move(request: ClaudeSessionMoveRequest): Promise<ClaudeSessionMoveOutcome>
}

type MoveController = Pick<RuntimePtyController, 'spawn' | 'getCwd' | 'getSize'> &
  Partial<Pick<RuntimePtyController, 'write' | 'serializeBuffer'>>

type MoveHandoffHooks = {
  getStatusSnapshotForPane: (paneKey: string) => readonly {
    state: string
    receivedAt: number
    providerSession?: { id: string }
    providerSessionOnly?: boolean
  }[]
  getProviderSessionIdentities: () => readonly { paneKey: string; sessionId: string }[]
}

export type ResumeMoveStrategyDeps = {
  getController: () => MoveController | null
  getSettings: () => AgentStartupSettings
  platform: NodeJS.Platform
  /** Hook readiness for the handoff note. Absent in tests that only check the resume spawn. */
  hooks?: MoveHandoffHooks
  translate?: ClaudeSessionMoveHandoffTranslate
}

const FALLBACK_SIZE = { cols: 120, rows: 40 }

export type ProxyMoveStrategyDeps = {
  getPane: (ptyId: string) => ClaudePaneAccountRecord | null
  assignSlot: (slot: string, accountId: string) => boolean
  assignAccount: (ptyId: string, accountId: string, providerSessionId: string) => boolean
  rememberSession: (sessionId: string, accountId: string) => void
}

/**
 * The pane already talks to the auth proxy. Point its slot at the target account; the next request
 * bills that account, and the PTY stays. A missing slot is `no-controller` (fall back is the caller's).
 */
export function createProxyMoveStrategy(deps: ProxyMoveStrategyDeps): ClaudeSessionMoveStrategy {
  return {
    async move(request) {
      const pane = deps.getPane(request.ptyId)
      if (!pane) {
        return { kind: 'skipped', reason: 'no-pane' }
      }
      if (!pane.proxySlot || !deps.assignSlot(pane.proxySlot, request.toAccountId)) {
        return { kind: 'skipped', reason: 'no-controller' }
      }
      if (!deps.assignAccount(request.ptyId, request.toAccountId, request.providerSession.id)) {
        return { kind: 'skipped', reason: 'no-pane' }
      }
      deps.rememberSession(request.providerSession.id, request.toAccountId)
      return { kind: 'moved', newPtyId: request.ptyId }
    }
  }
}

/**
 * `claude --resume <id>` in the same pane, spawned on the target account: the resume is built as the
 * phone's cold restore builds it; `replacesPtyId` stops the old PTY and swaps the pane binding;
 * `claudeAccountId` makes main's preflight inject the target account's folder.
 */
export function createResumeMoveStrategy(deps: ResumeMoveStrategyDeps): ClaudeSessionMoveStrategy {
  return {
    async move(request) {
      const controller = deps.getController()
      if (!controller?.spawn) {
        return { kind: 'skipped', reason: 'no-controller' }
      }
      const pane = parsePaneKey(request.paneKey)
      if (!pane) {
        return { kind: 'skipped', reason: 'no-pane' }
      }
      const settings = deps.getSettings()
      const cwd = (await controller.getCwd?.(request.ptyId)) ?? undefined
      // Why no defaults: a hand-started Claude must not come back with configured args such as a permission bypass.
      const plan = buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: request.providerSession,
        launchCwd: cwd,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentArgs: null,
        agentEnv: null,
        platform: deps.platform,
        shell: resolveStartupShell(deps.platform)
      })
      if (!plan) {
        return { kind: 'skipped', reason: 'no-resume-plan' }
      }
      const size = controller.getSize?.(request.ptyId) ?? FALLBACK_SIZE
      const baselineReceivedAt = deps.hooks
        ? claudeResumeHookBaseline(deps.hooks.getStatusSnapshotForPane(request.paneKey))
        : 0
      try {
        const result = await controller.spawn({
          ...size,
          ...(cwd ? { cwd } : {}),
          command: plan.launchCommand,
          launchAgent: 'claude',
          commandDelivery: 'provider',
          ...(plan.startupCommandDelivery
            ? { startupCommandDelivery: plan.startupCommandDelivery }
            : {}),
          ...(plan.env ? { env: plan.env } : {}),
          resumeProviderSession: request.providerSession,
          connectionId: request.connectionId,
          worktreeId: request.worktreeId,
          tabId: pane.tabId,
          leafId: pane.leafId,
          replacesPtyId: request.ptyId,
          claudeAccountId: request.toAccountId,
          isNewSession: true,
          // Why hidden + persisted: no renderer view exists for the new PTY yet (none at all on a server);
          // the pane binding is what a window or the CLI follows to it.
          initiallyHidden: true,
          persistHostSessionBinding: true
        })
        const handoffNote = await deliverHandoffNote(
          deps,
          controller,
          request,
          result.id,
          baselineReceivedAt
        )
        return {
          kind: 'moved',
          newPtyId: result.id,
          ...(request.handoff
            ? { endedWork: request.handoff.endedWork, ...(handoffNote ? { handoffNote } : {}) }
            : {})
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'failed',
          reason: message === 'terminal_pane_owner_changed' ? 'owner-changed' : 'spawn-failed',
          error: message
        }
      }
    }
  }
}

function hasPtyWrite(
  controller: MoveController
): controller is MoveController & Pick<RuntimePtyController, 'write'> {
  return typeof controller.write === 'function'
}

async function deliverHandoffNote(
  deps: ResumeMoveStrategyDeps,
  controller: MoveController,
  request: ClaudeSessionMoveRequest,
  newPtyId: string,
  baselineReceivedAt: number
): Promise<'sent' | 'unsent' | undefined> {
  if (!request.handoff) {
    return undefined
  }
  const writer = deps.getController() ?? controller
  if (!deps.hooks || !hasPtyWrite(writer)) {
    return 'unsent'
  }
  try {
    const handoffNote = await deliverClaudeSessionMoveHandoff({
      controller: writer,
      hooks: deps.hooks,
      ptyId: newPtyId,
      paneKey: request.paneKey,
      sessionId: request.providerSession.id,
      baselineReceivedAt,
      handoff: request.handoff,
      translate: deps.translate ?? ((_key, fallback) => fallback)
    })
    console.info(`[claude-session-mover] handoff note ${handoffNote} pty=${newPtyId}`)
    return handoffNote
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[claude-session-mover] handoff note failed: ${message}`)
    return 'unsent'
  }
}
