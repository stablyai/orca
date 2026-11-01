// Apply the window's split-pane exit rule in main, including headless exits.

import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalRunFactsRegister } from '../../terminal-run-facts'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'

export type ExitedSplitPaneFacts = {
  exitCode: number
  /** This main started the process for its pane, rather than reattaching or adopting it. */
  freshSpawn: boolean
  inputSeen: boolean
  outputSeen: boolean
  /** A client's view of the pane was showing when it ended. */
  shown: boolean
}

/** Keep failed/negative-code panes and unused newborns (splits only while shown); close removes the last pane's tab. Negative codes remain recoverable even with host-confirmed absence. */
export function exitedSplitPaneOutcome(
  facts: ExitedSplitPaneFacts,
  lastPane = false
): 'close' | 'keep' {
  if (facts.exitCode !== 0) {
    return 'keep'
  }
  if (lastPane) {
    return facts.freshSpawn && !facts.inputSeen ? 'keep' : 'close'
  }
  const newbornShown = facts.freshSpawn && facts.shown && !facts.inputSeen && !facts.outputSeen
  return newbornShown ? 'keep' : 'close'
}

/** What main knows about the run that ended, read before its records are cleared. */
export function exitedSplitPaneFacts(
  runs: Pick<TerminalRunFactsRegister, 'read' | 'readLastInputAt'>,
  pty: Pick<RuntimePtyWorktreeRecord, 'incarnationId' | 'lastOutputAt'> | undefined,
  ptyId: string,
  exitCode: number,
  options: { viewShown?: boolean }
): ExitedSplitPaneFacts {
  const run = runs.read(ptyId, pty?.incarnationId)
  return {
    // node-pty can report no code at all (its socket closed): that is lost contact, not a finish.
    exitCode: Number.isFinite(exitCode) ? exitCode : UNVERIFIED_PROCESS_EXIT_CODE,
    freshSpawn: run.freshSpawn,
    inputSeen: run.firstUserInputAt !== null || runs.readLastInputAt(ptyId) !== null,
    outputSeen: pty?.lastOutputAt != null,
    shown: options.viewShown === true
  }
}
