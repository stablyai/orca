/**
 * Which kind of worker `orchestration.workerStart` starts, decided from the user's own settings.
 *
 * There is no `--structured` flag: if the user's default is that a new agent tab opens as a
 * structured native chat, an orchestration worker is one too. That default is a preference, not a
 * demand, so a dispatch it cannot apply to falls back to an ordinary PTY terminal worker and the
 * receipt says which mode ran and why — a routine `worker-start` must never fail because the user
 * happens to have a chat preference on.
 *
 * The settings default and the per-launch feasibility both come from
 * `shared/structured-native-chat-launch-route`, the same module the renderer's
 * `resolveAgentLaunchRoute` uses. This adapter supplies placement facts and formats the receipt;
 * it does not own a second feasibility policy.
 */

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import {
  prefersStructuredNativeChatByDefault,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { hasExplicitTuiLaunchCustomization } from '../../../../shared/tui-agent-launch-customization'
import type { OrcaRuntimeService } from '../../orca-runtime'

export type WorkerStartMode = 'structured' | 'terminal'

export type WorkerStartModeReason =
  | 'user_default'
  | 'remote_execution_host'
  | 'reused_terminal'
  | 'agent_without_structured_session'
  | 'tui_launch_customization'
  | 'structured_sessions_unavailable'
  | 'structured_support_unknown'
  | 'wsl_execution_runtime'
  | 'codex_on_windows'
  | 'structured_unsupported_on_host'

export type WorkerStartModeReceipt = {
  /** The mode the worker actually started in. */
  mode: WorkerStartMode
  /** The user's settings default for a new agent tab. */
  preferred: WorkerStartMode
  reason: WorkerStartModeReason
  /** One sentence, always present, so a fallback is never silent. */
  detail: string
}

type WorkerStartModeSettings = Partial<
  NativeChatDefaultSettings &
    Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
>

/** The placement options that exist only on `worker-start`. `worktree`, `model` and `effort` are
 *  listed but no longer read: a structured worker honours all three, and naming them here keeps
 *  the set of options this decision has considered visible. */
type WorkerStartModePlacement = {
  agent?: string
  on?: string
  terminal?: string
  worktree?: string
  model?: string
  effort?: string
}

const DOWNGRADE_DETAIL: Record<Exclude<WorkerStartModeReason, 'user_default'>, string> = {
  remote_execution_host: 'this worker runs on a remote execution host',
  reused_terminal: '--terminal reuses a running terminal agent',
  agent_without_structured_session: 'this agent has no structured session',
  tui_launch_customization:
    'this agent has a custom launch command, arguments or environment that only a terminal applies',
  structured_sessions_unavailable: 'this runtime does not support structured agent sessions',
  structured_support_unknown: 'the execution host has not established structured session support',
  wsl_execution_runtime: 'this workspace runs under WSL',
  codex_on_windows: 'Codex has no structured session on Windows',
  structured_unsupported_on_host: 'the execution host cannot create one here'
}

const BLOCKER_REASON: Record<
  StructuredNativeChatBlocker,
  Exclude<WorkerStartModeReason, 'user_default'>
> = {
  'reused-terminal': 'reused_terminal',
  'agent-without-structured-session': 'agent_without_structured_session',
  'draft-prompt': 'structured_unsupported_on_host',
  'floating-workspace': 'structured_unsupported_on_host',
  'tui-launch-customization': 'tui_launch_customization',
  'remote-execution-host': 'remote_execution_host',
  'project-runtime': 'wsl_execution_runtime',
  'runtime-capability': 'structured_sessions_unavailable',
  'runtime-capability-unknown': 'structured_support_unknown'
}

/** The host's own create-support verdict (`agentSession.createSupport`) in this vocabulary. */
const HOST_SUPPORT_REASON: Record<
  'agent' | 'remote' | 'wsl',
  Exclude<WorkerStartModeReason, 'user_default'>
> = {
  agent: 'structured_unsupported_on_host',
  remote: 'remote_execution_host',
  wsl: 'wsl_execution_runtime'
}

export function decideWorkerStartMode(args: {
  params: WorkerStartModePlacement
  settings: WorkerStartModeSettings | null | undefined
}): WorkerStartModeReceipt {
  const { params, settings } = args
  if (!prefersStructuredNativeChatByDefault(settings)) {
    return {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'Started a terminal agent worker, the default for new agent tabs in your settings.'
    }
  }
  const agent = params.agent as TuiAgent
  const support = resolveStructuredNativeChatSupport({
    agent,
    executionHostId: params.on ? `runtime:${params.on}` : 'local',
    reusesTerminal: Boolean(params.terminal),
    hostCapabilities: RUNTIME_CAPABILITIES,
    // Orchestration resolves a managed worktree or folder workspace; a floating terminal is never
    // a worker placement. WSL is left to the executing host's own create-support probe, which
    // reads the resolved workspace rather than guessing from a client-side project runtime.
    requiresTuiLaunchCustomization: hasExplicitTuiLaunchCustomization(settings, agent)
  })
  if (!support.supported) {
    return downgraded(BLOCKER_REASON[support.blocker])
  }
  return {
    mode: 'structured',
    preferred: 'structured',
    reason: 'user_default',
    detail:
      'Started a structured chat session worker, the default for new agent tabs in your settings.'
  }
}

/**
 * Second half of the decision, once the worktree is resolved: the host that will run the worker
 * answers whether it can create a structured session there at all. Asked before anything is
 * created, so a refusal becomes a terminal worker rather than a failed start.
 */
export async function resolveWorkerStartModeOnHost(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  mode: WorkerStartModeReceipt,
  worktreeId: string | undefined,
  agent: TuiAgent | undefined
): Promise<WorkerStartModeReceipt> {
  if (mode.mode !== 'structured' || !worktreeId) {
    return mode
  }
  return downgradeWorkerStartModeForHost(
    mode,
    await readStructuredCreateSupport(runtime, worktreeId, agent)
  )
}

/** A host that cannot answer has not proved it can create one, so the worker stays a PTY agent. */
async function readStructuredCreateSupport(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  worktreeId: string,
  agent: TuiAgent | undefined
): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null> {
  if (agent !== 'claude' && agent !== 'codex') {
    return { supported: false, reason: 'agent' }
  }
  try {
    return await runtime.getStructuredAgentSessionCreateSupport(`id:${worktreeId}`, agent)
  } catch {
    return null
  }
}

/**
 * Applies the executing host's `agentSession.createSupport` answer, which is the authority on WSL,
 * remoteness and the Windows process-start-time gate for the resolved workspace.
 */
export function downgradeWorkerStartModeForHost(
  receipt: WorkerStartModeReceipt,
  support: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null
): WorkerStartModeReceipt {
  if (receipt.mode !== 'structured' || support?.supported) {
    return receipt
  }
  if (support === null) {
    return downgraded(BLOCKER_REASON['runtime-capability-unknown'])
  }
  return downgraded(
    support.reason ? HOST_SUPPORT_REASON[support.reason] : 'structured_unsupported_on_host'
  )
}

function downgraded(
  reason: Exclude<WorkerStartModeReason, 'user_default'>
): WorkerStartModeReceipt {
  return {
    mode: 'terminal',
    preferred: 'structured',
    reason,
    detail: `Your default is a structured chat session, but ${DOWNGRADE_DETAIL[reason]}; started a terminal agent worker instead.`
  }
}

/** The store can be missing on a runtime that never opened one; that reads as no preference. */
export function readWorkerStartModeSettings(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): WorkerStartModeSettings | null {
  try {
    return runtime.getClientSettings()
  } catch {
    return null
  }
}
