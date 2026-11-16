import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { isEditableTarget, isNativeChatPromptTarget } from '@/lib/text-input/focus/editable-target'

export function createPluginsSettingsShortcutHandler(
  target: EventTarget | null | undefined,
  claim: () => boolean
): () => boolean {
  return () => {
    // Why: rich-text editors use Mod+Shift+X for strikethrough.
    if (
      isPairedWebClientWindow() ||
      (isEditableTarget(target ?? null) && !isNativeChatPromptTarget(target ?? null))
    ) {
      return false
    }
    return claim()
  }
}
