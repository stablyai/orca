import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { isEditableTarget } from '@/lib/editable-target'

export function createPluginsSettingsShortcutHandler(
  target: EventTarget | null | undefined,
  claim: () => boolean
): () => boolean {
  return () => {
    // Why: rich-text editors use Mod+Shift+X for strikethrough.
    if (isPairedWebClientWindow() || isEditableTarget(target ?? null)) {
      return false
    }
    return claim()
  }
}
