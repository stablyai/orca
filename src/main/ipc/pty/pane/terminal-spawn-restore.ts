import type { PtySpawnResult } from '../../../providers/types'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { pendingByPaneKey, rendererSerializerReadiness } from './serializer-state'

export function seedHeadlessTerminalFromSpawnResult(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  paneKey: string | null
): void {
  // A mounted renderer owns richer history than the provider snapshot.
  if (
    !runtime ||
    (paneKey && pendingByPaneKey.has(paneKey)) ||
    (result.isReattach === true && rendererSerializerReadiness.has(result.id))
  ) {
    return
  }
  if (typeof result.snapshot === 'string' && result.snapshot.length > 0) {
    const size =
      typeof result.snapshotCols === 'number' && typeof result.snapshotRows === 'number'
        ? { cols: result.snapshotCols, rows: result.snapshotRows }
        : undefined
    runtime.seedHeadlessTerminal(result.id, result.snapshot, size, {
      ...(typeof result.snapshotKittyKeyboardFlags === 'number'
        ? { kittyKeyboardFlags: result.snapshotKittyKeyboardFlags }
        : {}),
      ...(result.snapshotTerminalOwner ? { terminalOwner: result.snapshotTerminalOwner } : {})
    })
  } else if (
    result.coldRestore &&
    typeof result.coldRestore.scrollback === 'string' &&
    result.coldRestore.scrollback.length > 0
  ) {
    const size =
      typeof result.coldRestore.cols === 'number' && typeof result.coldRestore.rows === 'number'
        ? { cols: result.coldRestore.cols, rows: result.coldRestore.rows }
        : undefined
    runtime.seedHeadlessTerminal(result.id, result.coldRestore.scrollback, size, {
      cwd: result.coldRestore.cwd,
      oscLinks: result.coldRestore.oscLinks,
      preferProviderIfExisting: true
    })
  } else if (typeof result.replay === 'string' && result.replay.length > 0) {
    runtime.seedHeadlessTerminal(result.id, result.replay)
  }
}
