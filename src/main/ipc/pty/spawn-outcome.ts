import {
  terminalExitError,
  terminalStartError,
  type TerminalStartFailure
} from '../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import { terminalAttachResult } from '../../../shared/terminal/pty/lifecycle/terminal-attach-result'
import type { AdoptStablePaneResult } from './ipc/spawn-types'
import type { StartupCwdFallback } from '../../../shared/startup-cwd-fallback'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { StablePaneOwner } from './pane/stable-owner'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'

/** One host result; reply adapters never decide how the owning operation settles. */
export type PtySpawnOutcome = {
  kind: 'committed' | 'adopted' | 'registration-exited'
  terminalStartFailure?: TerminalStartFailure
  settlementError?: unknown
  owner?: StablePaneOwner
  result: PtySpawnResult & {
    savedStartupCwd?: string
    startupCwdFallback?: StartupCwdFallback
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    launchConfig?: SleepingAgentLaunchConfig
    agentResumeUnavailable?: true
  }
}

/** Internal prepared-operation evidence; adapters never infer it from a later exception. */
export type PreparedPtySpawnSettlement =
  | { kind: 'outcome'; outcome: PtySpawnOutcome }
  | { kind: 'rejected' | 'unknown' | 'superseded'; error: unknown }

import '../../../shared/terminal/pty/lifecycle/terminal-spawn-response'

export function requireAcceptedSpawn(
  outcome: PtySpawnOutcome,
  refusalCode = 'agent_session_exited_during_start'
): PtySpawnOutcome['result'] {
  if (outcome.kind === 'registration-exited') {
    if (outcome.settlementError !== undefined) {
      throw outcome.settlementError
    }
    const failure = outcome.terminalStartFailure
    throw failure
      ? terminalStartError(refusalCode, failure.cause, failure.incarnationId)
      : terminalExitError(refusalCode, undefined, outcome.result.incarnationId)
  }
  return outcome.result
}

export function adoptedOutcome(adopted: AdoptStablePaneResult): PtySpawnOutcome {
  return {
    ...(adopted.outcome ?? { kind: 'adopted' }),
    result: terminalAttachResult(adopted.result),
    owner: adopted.owner
  }
}
