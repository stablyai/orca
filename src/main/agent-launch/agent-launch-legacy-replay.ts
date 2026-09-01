// Opaque one-release legacy-config replay (U5, plan §570-575). A pre-U5 sleeping
// record persisted a pre-quoted `agentCommand` that "cannot always be split
// safely", so it is replayed verbatim as an opaque string rather than re-parsed
// into the v1 snapshot's structured argv. This path is desktop/host-initiated
// only: the renderer surrenders the legacy config over trusted IPC exactly once,
// the host validates it, the ingest layer persists it into the private record
// store (owns it thereafter), and it never rides untrusted runtime/mobile RPC —
// so a mobile/paired legacy resume falls through to invalid_launch_snapshot.
//
// Unlike the resolver, this does NOT produce a ResolvedAgentLaunch: the opaque
// command bypasses structured resolution and feeds the pre-U5 launchCommand /
// launchConfig fields directly. The durable config stays base-only (no resume
// flags) so a fresh relaunch never re-resumes a stale session; the provider
// resume flags land only in the one-shot launchCommand.

import type { TuiAgent } from '../../shared/types'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import { validateCustomAgentEnv } from '../../shared/custom-tui-agent-fields'
import { quoteStartupArg, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { stripLegacyReplayEnv } from './agent-launch-legacy-teams-env'

export type LegacyReplayInput = {
  legacyLaunchConfig: SleepingAgentLaunchConfig
  requestedAgent: TuiAgent
  baseAgent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  shell: AgentStartupShell
  /** Recorded execution owner of the sleeping pane. */
  recordedConnectionId: string | null
  /** Current spawn's execution owner; provenance requires it to equal the
   *  recorded owner (never inferred from focused repo/client — plan §573). */
  currentConnectionId: string | null
}

export type LegacyReplayResult =
  | {
      ok: true
      launchCommand: string
      launchConfig: SleepingAgentLaunchConfig
      requestedAgent: TuiAgent
      baseAgent: ResumableTuiAgent
    }
  | { ok: false; failure: { code: 'invalid_launch_snapshot' } }

const INVALID: LegacyReplayResult = { ok: false, failure: { code: 'invalid_launch_snapshot' } }

// The user-facing failure is one generic code, so the rejecting gate must be
// diagnosable from logs. Reasons + identity only — never command/env contents.
function invalid(
  input: LegacyReplayInput,
  reason: string,
  detail?: Record<string, string | null>
): LegacyReplayResult {
  console.warn(
    `[agent-launch] legacy resume replay rejected (${reason}) base=${input.baseAgent}`,
    detail ?? ''
  )
  return INVALID
}

// Control chars that would corrupt an opaque shell command. Mirrors the command
// override guard; the pre-quoted command text is otherwise passed through.
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const COMMAND_CONTROL_RE = /[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/

/** Assemble an opaque legacy resume launch. Fails closed (`invalid_launch_snapshot`,
 *  leaving the source record untouched) on owner mismatch, an unresumable base, an
 *  empty/control-char command, or invalid surviving env — never a partial replay. */
export function buildLegacyResumeReplay(input: LegacyReplayInput): LegacyReplayResult {
  // Provenance: the recorded execution owner must match the current spawn's owner.
  // Missing/conflicting owner evidence fails closed rather than inferring a target.
  if ((input.recordedConnectionId ?? null) !== (input.currentConnectionId ?? null)) {
    return invalid(input, 'execution owner mismatch', {
      recorded: input.recordedConnectionId ?? null,
      current: input.currentConnectionId ?? null
    })
  }

  const { agentCommand, agentArgs } = input.legacyLaunchConfig
  const command = agentCommand?.trim() ?? ''
  if (!command || COMMAND_CONTROL_RE.test(command)) {
    return invalid(input, command ? 'control chars in command' : 'empty command')
  }
  const trimmedArgs = agentArgs.trim()
  if (trimmedArgs && COMMAND_CONTROL_RE.test(trimmedArgs)) {
    return invalid(input, 'control chars in args')
  }

  // Strip Orca attribution + generated Agent Teams keys (and the proven shim PATH
  // prefix) first, then validate the surviving user env as a whole; any invalid
  // key/value invalidates the entire config (never partial). The downstream
  // launch path regenerates a fresh team plan for a captured team config.
  const cleanedEnv = stripLegacyReplayEnv(input.legacyLaunchConfig.agentEnv, input.shell)
  if (validateCustomAgentEnv(cleanedEnv).length > 0) {
    return invalid(input, 'invalid surviving env')
  }

  // Provider resume flags append to the one-shot command only. An unresumable
  // base or a session whose key type does not match the base cannot resume.
  const ompResumeFilePath = input.legacyLaunchConfig.ompResumeFilePath?.trim()
  const resumeArgv = getAgentResumeArgv(input.baseAgent, input.providerSession, ompResumeFilePath)
  if (!resumeArgv) {
    return invalid(input, 'no resume argv for base')
  }
  const resumeSuffix = resumeArgv
    .slice(1)
    .map((element) => quoteStartupArg(element, input.shell))
    .join(' ')

  // Why: a captured `agentCommand` is the COMPLETE base command — buildSleepingAgentLaunchConfig
  // stores resolveAgentLaunchCommand's `commandWithoutSessionOptions`, which already
  // embeds the quoted agentArgs, and pre-U5 resume launched that string alone.
  // Re-appending the raw args string would double every flag and splice it unquoted.
  const launchCommand = [command, resumeSuffix].filter(Boolean).join(' ')
  return {
    ok: true,
    launchCommand,
    // Durable config: base command/args only (no resume flags), cleaned env.
    launchConfig: {
      agentCommand: command,
      agentArgs: trimmedArgs,
      agentEnv: cleanedEnv,
      ...(ompResumeFilePath ? { ompResumeFilePath } : {})
    },
    requestedAgent: input.requestedAgent,
    baseAgent: input.baseAgent
  }
}
