/**
 * Which surface a launch gets — a structured chat session or a terminal agent — decided from the
 * user's own settings and the executing host's answer.
 *
 * No caller passes a mode. If the user's default is that a new agent tab opens as a structured
 * native chat, then every launch is one: an orchestration worker, a mobile create, a CLI create,
 * a renderer tab. That default is a preference rather than a demand, so a launch it cannot apply
 * to falls back to a PTY terminal and the receipt says which mode ran and why — a routine launch
 * must never fail because the user happens to have a chat preference on.
 *
 * The settings default and the per-launch feasibility both come from
 * `shared/structured-native-chat-launch-route`. This module supplies placement facts and formats
 * the receipt; it does not own a second feasibility policy.
 *
 * Callers differ only in what they call the thing being started, so the receipt's noun is
 * parameterized. Orchestration says "worker" because its receipts are read alongside dispatch
 * records; every other surface says "chat session" / "terminal agent".
 */

import type {
  AgentLaunchMode,
  AgentLaunchModeReason,
  AgentLaunchModeReceipt
} from '../../shared/agent-launch-intent'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import {
  prefersStructuredNativeChatByDefault,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatBlocker
} from '../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../shared/tui-agent'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import type { WorkspaceLaunchKind } from '../../shared/workspace-launch-kind'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

// The receipt is part of the launch contract, so it is declared with the rest of it; re-exported
// here because this module is where the decision that fills it lives.
export type { AgentLaunchMode, AgentLaunchModeReason, AgentLaunchModeReceipt }

/** What this caller calls the thing it is starting, so one decision serves every surface without
 *  a receipt reading "worker" on a phone. */
export type AgentLaunchModeVocabulary = {
  /** e.g. 'a structured chat session worker' */
  structured: string
  /** e.g. 'a terminal agent worker' */
  terminal: string
  /** Per-reason wording a surface states differently. Orchestration names the `--terminal` flag
   *  in its reused-terminal detail, which would be meaningless in a phone's receipt. */
  detailOverrides?: Partial<Record<Exclude<AgentLaunchModeReason, 'user_default'>, string>>
}

export const DEFAULT_LAUNCH_VOCABULARY: AgentLaunchModeVocabulary = {
  structured: 'a structured chat session',
  terminal: 'a terminal agent'
}

export type AgentLaunchModeSettings = Partial<
  NativeChatDefaultSettings & Pick<GlobalSettings, 'agentCmdOverrides'>
>

/** The placement facts the decision reads. `worktree`, `model` and `effort` are deliberately not
 *  here: a structured launch honours all three, and a placement flag must never imply a mode. */
export type AgentLaunchModePlacement = {
  agent?: string
  /** A connected execution server; absent means local. */
  on?: string
  /** An existing terminal being reused. */
  terminal?: string
  /** Which kind of workspace the launch lands in, derived by the host from the workspace it
   *  resolved — never accepted from a caller, which would let one route around this decision.
   *  Absent means the kind was never established, and is not read as any particular kind. */
  workspaceKind?: WorkspaceLaunchKind
  /** A start directory other than the workspace root. It belongs here, unlike `model` or `effort`,
   *  because a structured session has no way to apply one — it runs in its workspace — so honouring
   *  it and honouring the chat preference are mutually exclusive rather than merely awkward. */
  cwd?: string
}

const DOWNGRADE_DETAIL: Record<Exclude<AgentLaunchModeReason, 'user_default'>, string> = {
  remote_execution_host: 'this launch runs on a remote execution host',
  reused_terminal: 'it reuses a running terminal agent',
  agent_without_structured_session: 'this agent has no structured session',
  tui_launch_command: 'this agent has a custom launch command that only a terminal runs',
  structured_sessions_unavailable: 'this runtime does not support structured agent sessions',
  structured_support_unknown: 'the execution host has not established structured session support',
  wsl_execution_runtime: 'this workspace runs under WSL',
  codex_on_windows: 'Codex has no structured session on Windows',
  structured_unsupported_on_host: 'the execution host cannot create one here'
}

const BLOCKER_REASON: Record<
  StructuredNativeChatBlocker,
  Exclude<AgentLaunchModeReason, 'user_default'>
> = {
  'reused-terminal': 'reused_terminal',
  'agent-without-structured-session': 'agent_without_structured_session',
  'floating-workspace': 'structured_unsupported_on_host',
  'tui-launch-command': 'tui_launch_command',
  'remote-execution-host': 'remote_execution_host',
  'project-runtime': 'wsl_execution_runtime',
  'runtime-capability': 'structured_sessions_unavailable',
  'runtime-capability-unknown': 'structured_support_unknown'
}

/** The host's own create-support verdict (`agentSession.createSupport`) in this vocabulary. */
const HOST_SUPPORT_REASON: Record<
  'agent' | 'remote' | 'wsl',
  Exclude<AgentLaunchModeReason, 'user_default'>
> = {
  agent: 'structured_unsupported_on_host',
  remote: 'remote_execution_host',
  wsl: 'wsl_execution_runtime'
}

/**
 * First half of the decision: the user's default, plus every feasibility fact knowable before a
 * workspace is resolved.
 */
export function decideAgentLaunchMode(args: {
  placement: AgentLaunchModePlacement
  settings: AgentLaunchModeSettings | null | undefined
  vocabulary?: AgentLaunchModeVocabulary
}): AgentLaunchModeReceipt {
  const { placement, settings } = args
  const vocabulary = args.vocabulary ?? DEFAULT_LAUNCH_VOCABULARY
  if (!prefersStructuredNativeChatByDefault(settings)) {
    return {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: `Started ${vocabulary.terminal}, the default for new agent tabs in your settings.`
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unrecognized agent name is handled rather than trusted; isAgentSessionHandleProvider rejects it and the launch downgrades to a terminal.
  const agent = placement.agent as TuiAgent
  const support = resolveStructuredNativeChatSupport({
    agent,
    executionHostId: placement.on ? `runtime:${placement.on}` : 'local',
    reusesTerminal: Boolean(placement.terminal),
    hostCapabilities: RUNTIME_CAPABILITIES,
    // The floating workspace has nowhere to keep a session, so it is decided here rather than left
    // to the host probe below, which cannot answer for a workspace with no record. WSL still is:
    // the create-support probe reads the resolved workspace rather than guessing from a
    // client-side project runtime.
    ...(placement.workspaceKind ? { workspaceKind: placement.workspaceKind } : {}),
    // Mirrors the renderer's own route input (`agent-launch-route-input.ts`), which has always
    // treated a requested cwd as terminal-only; the host simply had no way to be told about one.
    requiresTuiLaunchCommand:
      Boolean(placement.cwd?.trim()) || hasExplicitTuiLaunchCommand(settings, agent)
  })
  if (!support.supported) {
    return downgraded(BLOCKER_REASON[support.blocker], vocabulary)
  }
  return {
    mode: 'structured',
    preferred: 'structured',
    reason: 'user_default',
    detail: `Started ${vocabulary.structured}, the default for new agent tabs in your settings.`
  }
}

/**
 * Second half, once the workspace is resolved: the host that will run the agent answers whether it
 * can create a structured session there at all. Asked before anything is created, so a refusal
 * becomes a terminal agent rather than a failed launch.
 */
export async function resolveAgentLaunchModeOnHost(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  receipt: AgentLaunchModeReceipt,
  worktreeId: string | undefined,
  agent: TuiAgent | undefined,
  vocabulary: AgentLaunchModeVocabulary = DEFAULT_LAUNCH_VOCABULARY
): Promise<AgentLaunchModeReceipt> {
  if (receipt.mode !== 'structured' || !worktreeId) {
    return receipt
  }
  return downgradeAgentLaunchModeForHost(
    receipt,
    await readStructuredCreateSupport(runtime, worktreeId, agent),
    vocabulary
  )
}

/** A host that cannot answer has not proved it can create one, so the launch stays a PTY agent. */
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
export function downgradeAgentLaunchModeForHost(
  receipt: AgentLaunchModeReceipt,
  support: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null,
  vocabulary: AgentLaunchModeVocabulary = DEFAULT_LAUNCH_VOCABULARY
): AgentLaunchModeReceipt {
  if (receipt.mode !== 'structured' || support?.supported) {
    return receipt
  }
  if (support === null) {
    return downgraded(BLOCKER_REASON['runtime-capability-unknown'], vocabulary)
  }
  return downgraded(
    support.reason ? HOST_SUPPORT_REASON[support.reason] : 'structured_unsupported_on_host',
    vocabulary
  )
}

function downgraded(
  reason: Exclude<AgentLaunchModeReason, 'user_default'>,
  vocabulary: AgentLaunchModeVocabulary
): AgentLaunchModeReceipt {
  const why = vocabulary.detailOverrides?.[reason] ?? DOWNGRADE_DETAIL[reason]
  return {
    mode: 'terminal',
    preferred: 'structured',
    reason,
    detail: `Your default is a structured chat session, but ${why}; started ${vocabulary.terminal} instead.`
  }
}

/** The store can be missing on a runtime that never opened one; that reads as no preference. */
export function readAgentLaunchModeSettings(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): AgentLaunchModeSettings | null {
  try {
    return runtime.getClientSettings()
  } catch {
    return null
  }
}
