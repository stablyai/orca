/**
 * How long a blocking orchestration call may hold a structured session's command. The provider runs
 * each command under its shell tool's timeout and kills it there, so a wait the tool outlives ends
 * in a kill, not the normal timed-out result. The host returns first; a terminal caller is uncapped.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { OrchestrationSessionCaller } from './orchestration-caller-identity'
import { readAgentSessionRecordStore } from './structured-session-lineage'

// Each provider's default shell-tool timeout, less headroom for the CLI's startup and the reply:
// Codex's one-shot exec default is 10s (codex-rs core/src/exec.rs DEFAULT_EXEC_COMMAND_TIMEOUT_MS);
// Claude Code's Bash tool default is 120s.
const SESSION_WAIT_CAP_MS: Readonly<Record<AgentSessionRecord['provider'], number>> = {
  codex: 6_000,
  claude: 100_000
}

type WaitCaller = Pick<OrchestrationSessionCaller, 'sessionId'> | null | undefined

export function capSessionCallerWaitMs(timeoutMs: number, caller: WaitCaller): number
export function capSessionCallerWaitMs(
  timeoutMs: number | undefined,
  caller: WaitCaller
): number | undefined
export function capSessionCallerWaitMs(
  timeoutMs: number | undefined,
  caller: WaitCaller
): number | undefined {
  if (!caller) {
    return timeoutMs
  }
  const provider = readAgentSessionRecordStore()?.getRecord(caller.sessionId)?.provider
  // Why the shortest cap when the provider is unknown: returning early is harmless, a kill is not.
  const cap = provider
    ? SESSION_WAIT_CAP_MS[provider]
    : Math.min(...Object.values(SESSION_WAIT_CAP_MS))
  return timeoutMs === undefined ? cap : Math.min(timeoutMs, cap)
}
