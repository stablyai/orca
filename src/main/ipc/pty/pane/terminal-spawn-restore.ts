import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { pendingByPaneKey, rendererSerializerReadiness } from './serializer-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { buildFreshShellViewportBlankingSequence } from '../../../../shared/terminal/viewport/terminal-fresh-shell-viewport'

export function seedHeadlessTerminalFromSpawnResult(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  paneKey: string | null
): void {
  if (!runtime || (result.isReattach === true && rendererSerializerReadiness.has(result.id))) {
    return
  }
  // Renderer-owned layout prefers its richer history; main-owned layout must seed the host copy every view restores.
  const rendererOwnsHistory = Boolean(
    !ORCA_LAYOUT_OWNER_IS_MAIN && paneKey && pendingByPaneKey.has(paneKey)
  )
  if (typeof result.snapshot === 'string' && result.snapshot.length > 0) {
    if (rendererOwnsHistory) {
      return
    }
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
    // Seed even when the renderer owns history: its xterm holds only this same payload, and a pane
    // revealed after output arrived while hidden repaints from the host copy (STA-14063).
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
  } else if (
    !rendererOwnsHistory &&
    typeof result.replay === 'string' &&
    result.replay.length > 0
  ) {
    runtime.seedHeadlessTerminal(result.id, result.replay)
  }
}
