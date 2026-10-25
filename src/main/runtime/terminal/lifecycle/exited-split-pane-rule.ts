// What main does with a split pane whose terminal ended, in a layout-owner build: the rule the
// window applied to the panes it mounted, now decided where the exit is seen, window or none.

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

/**
 * 'close' takes the pane out of its tab (a tab's last pane, the tab). 'keep' leaves it: a failed
 * process (its "Terminal exited" card stays), a newborn that died before anyone used it (a split
 * only while shown), or any negative code, as the window keeps it (pty-exit-hibernate's
 * isProvenProcessExit reads only the code, so a host-confirmed absence keeps its pane to recover).
 */
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
