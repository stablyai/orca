import type { OverlayModel } from './overlay-frame'
import type { ControllerOverlay } from './tui-input'
import type { Platform } from './keybinding-map'
import type { WorktreeRow } from './worktree-snapshot'

/** Map the controller's overlay (which carries command/build closures) to the
 *  render-only overlay model the compositor draws. */
export function toOverlayModel(
  overlay: ControllerOverlay,
  inputValue: string,
  platform: Platform
): OverlayModel {
  if (overlay.kind === 'help') {
    return { kind: 'help', platform }
  }
  if (overlay.kind === 'confirm') {
    return { kind: 'confirm', message: overlay.message }
  }
  if (overlay.kind === 'prompt') {
    return { kind: 'prompt', label: overlay.label, value: inputValue }
  }
  return { kind: 'none' }
}

/** The footer context label: name, plus the branch when it adds information. */
export function contextLabel(selected: WorktreeRow | null): string {
  if (!selected) {
    return ''
  }
  const branch = selected.branch.replace(/^refs\/heads\//, '')
  return branch.length > 0 && branch !== selected.displayName
    ? `${selected.displayName} · ${branch}`
    : selected.displayName
}
