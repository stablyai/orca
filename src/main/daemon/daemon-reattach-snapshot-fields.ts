import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import type { PtySpawnResult } from '../providers/pty-provider-contract'
import type { TerminalSnapshot } from './types'

export function reattachSnapshotSpawnFields(
  reattachSnapshot: TerminalSnapshot,
  providerSequence: PtySpawnResult['providerSequence']
) {
  const reattachProviderSequence =
    typeof reattachSnapshot.outputSequence === 'number'
      ? { value: reattachSnapshot.outputSequence, generation: 'continued' as const }
      : providerSequence
  const isAltScreen = reattachSnapshot.modes.alternateScreen
  const snapshotPrefix = reattachSnapshot.scrollbackAnsi + reattachSnapshot.rehydrateSequences
  const snapshotFrame = reattachSnapshot.snapshotAnsi
  const snapshotPayload = snapshotPrefix + snapshotFrame
  // Reassert kitty flags after payload screen switches; carry known zero separately from unknown.
  const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(
    reattachSnapshot.modes.kittyKeyboardFlags
  )
  return {
    snapshot: snapshotPayload,
    snapshotCols: reattachSnapshot.cols,
    snapshotRows: reattachSnapshot.rows,
    // Only alt frames need a separate restore; normal history can replay at its captured grid.
    ...(isAltScreen && snapshotFrame && reattachSnapshot.frameRestoreAnsi
      ? {
          snapshotPrefixAnsi: snapshotPrefix,
          snapshotFrameAnsi: snapshotFrame,
          snapshotFrameRestoreAnsi: reattachSnapshot.frameRestoreAnsi
        }
      : {}),
    ...(reattachProviderSequence ? { providerSequence: reattachProviderSequence } : {}),
    ...(kittyKeyboardFlags !== undefined ? { snapshotKittyKeyboardFlags: kittyKeyboardFlags } : {}),
    ...(reattachSnapshot.terminalOwner
      ? { snapshotTerminalOwner: reattachSnapshot.terminalOwner }
      : {}),
    isReattach: true,
    isAlternateScreen: isAltScreen,
    // Snapshot ANSI lacks title frames; carry the title separately across relaunch.
    ...(reattachSnapshot.lastTitle ? { lastTitle: reattachSnapshot.lastTitle } : {}),
    // Replay the mid-escape tail after renderer reset so split escapes do not render literally.
    ...(reattachSnapshot.pendingEscapeTailAnsi
      ? { pendingEscapeTailAnsi: reattachSnapshot.pendingEscapeTailAnsi }
      : {})
  }
}
