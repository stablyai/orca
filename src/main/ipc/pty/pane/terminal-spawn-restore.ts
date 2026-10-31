import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { pendingByPaneKey, rendererSerializerReadiness } from './serializer-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { buildFreshShellViewportBlankingSequence } from '../../../../shared/terminal-fresh-shell-viewport'

export function seedHeadlessTerminalFromSpawnResult(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  paneKey: string | null
): void {
  // Renderer-owned layout prefers its richer history; main-owned layout must seed the host copy every view restores.
  if (
    !runtime ||
    (!ORCA_LAYOUT_OWNER_IS_MAIN && paneKey && pendingByPaneKey.has(paneKey)) ||
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
    // A fresh shell follows the restored history: park the cursor below it, as the window does,
    // or a view painted from this copy (a paired host's desktop, a phone) joins the new prompt.
    const seed = `${result.coldRestore.scrollback}${buildFreshShellViewportBlankingSequence(
      size?.rows ?? 24
    )}`
    runtime.seedHeadlessTerminal(result.id, seed, size, {
      cwd: result.coldRestore.cwd,
      oscLinks: result.coldRestore.oscLinks,
      preferProviderIfExisting: true
    })
  } else if (typeof result.replay === 'string' && result.replay.length > 0) {
    runtime.seedHeadlessTerminal(result.id, result.replay)
  }
}
