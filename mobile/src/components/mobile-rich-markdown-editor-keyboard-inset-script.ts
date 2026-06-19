// In-page script that reports the height covered by the on-screen keyboard.
// Native Keyboard events are unreliable while focus lives in the editor
// WebView, so measure the covered region directly from visualViewport and let
// RN lift its native Save/Discard bar above it.
export function normalizeMobileRichMarkdownKeyboardInset(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.max(0, Math.round(value))
}

export const MOBILE_RICH_MARKDOWN_KEYBOARD_INSET_SCRIPT = `
      var lastInset = -1;
      function reportKeyboardInset() {
        var viewport = window.visualViewport;
        var bottom = viewport
          ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
          : 0;
        var rounded = Math.round(bottom);
        if (rounded === lastInset) return;
        lastInset = rounded;
        post({ type: 'keyboardInset', bottom: rounded });
      }
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reportKeyboardInset);
        window.visualViewport.addEventListener('scroll', reportKeyboardInset);
        reportKeyboardInset();
      }`
