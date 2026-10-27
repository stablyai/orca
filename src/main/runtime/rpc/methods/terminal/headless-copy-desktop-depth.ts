import type { OrcaRuntimeService } from '../../../orca-runtime'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../../shared/terminal-scrollback-policy'

type HeadlessCopySource = Pick<
  OrcaRuntimeService,
  | 'getPtyOutputSequence'
  | 'serializeRendererTerminalBuffer'
  | 'replaceHeadlessTerminalFromRendererSnapshotForRecovery'
>

/**
 * After a phone-sized seed is published, re-seed main's copy at desktop depth: desktop reveals repaint
 * from it. Only while no output has followed the phone snapshot, so the deeper read covers the same bytes.
 * Best-effort: never throws, so callers may fire and forget.
 */
export async function deepenHeadlessCopyToDesktopDepth(
  runtime: HeadlessCopySource,
  ptyId: string,
  phoneSnapshot: { seq?: number },
  isCurrent: () => boolean
): Promise<boolean> {
  const seq = phoneSnapshot.seq
  if (typeof seq !== 'number' || runtime.getPtyOutputSequence(ptyId) !== seq) {
    return false
  }
  try {
    const desktop = await runtime.serializeRendererTerminalBuffer(ptyId, {
      scrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
    })
    if (
      !isCurrent() ||
      !desktop?.data ||
      desktop.seq !== seq ||
      runtime.getPtyOutputSequence(ptyId) !== seq
    ) {
      return false
    }
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, desktop)
    return true
  } catch {
    return false
  }
}
