import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { isQuietForQuiescence } from './quiet-foreground-quiescence'
import { settlesForMidTurnInput } from './terminal-delivery-refusal'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { TerminalWaiter } from './terminal-waiter'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { evaluateTuiIdle, type QuietForegroundLane, type TuiIdleVerdict } from './tui-idle-evidence'
import {
  outputClockOf,
  ptyTuiIdleEvidence,
  type TuiIdleEvidenceSource
} from './tui-idle-evidence-source'

export type RuntimeTerminalIdlePollDependencies = TuiIdleEvidenceSource & {
  intervalMs: number
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  /** Ingested output position; distinct chunks can share an output timestamp. */
  getOutputSequence(ptyId: string): number
  /** Whether the pane's running command has painted anything of its own. */
  hasCommandPainted(ptyId: string): boolean
  /** The pane's rendered viewport, or null when the runtime holds no screen model for it. */
  readVisibleScreen(ptyId: string): Promise<string | null> | null
  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void
  /** Asks a reattached pane's program to repaint, once per reattach and only before it painted. */
  requestReattachedRepaint?(ptyId: string): void
  /** True once a fresh read put the rest title's own agent in front and its idle was admitted. */
  confirmRestTitle?(ptyId: string, agent: TuiAgent): Promise<boolean>
}

/** One reading of a waiter's pane, and the results it would settle with. */
export type IdlePollSample = {
  verdict: TuiIdleVerdict
  /** A mid-turn agent that takes input settles a waiter that accepts it. */
  takesInputNow: boolean
  ptyId: string
  ready(): RuntimeTerminalWait
  blocked(reason: RuntimeTerminalWaitBlockedReason): RuntimeTerminalWait
  isQuiet(lane: QuietForegroundLane): boolean
}

export function sampleTerminalIdlePoll(
  waiter: TerminalWaiter,
  pty: RuntimePtyWorktreeRecord,
  deps: TuiIdleEvidenceSource & { hasCommandPainted(ptyId: string): boolean },
  evidenceSource: TuiIdleEvidenceSource
): IdlePollSample {
  const { handle } = waiter
  // PTY records mutate in place, so this captured reference remains live.
  const readWaitText = () => buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
  const evidence = ptyTuiIdleEvidence(evidenceSource, pty, readWaitText)
  const verdict = evaluateTuiIdle({ ...evidence, launchReadiness: waiter.launchReadiness })
  return {
    verdict,
    takesInputNow: !!waiter.acceptsMidTurnInput && settlesForMidTurnInput(verdict, pty.ptyId, deps),
    ptyId: pty.ptyId,
    ready: () => buildPtyTerminalWaitResult(handle, 'tui-idle', pty),
    blocked: (reason) => buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty, reason),
    isQuiet: (lane) =>
      isQuietForQuiescence(outputClockOf(deps, pty), deps.quiescenceMs, lane, () =>
        deps.hasCommandPainted(pty.ptyId)
      )
  }
}
