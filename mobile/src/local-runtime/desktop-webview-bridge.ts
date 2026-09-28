/**
 * The page side of the edge-to-edge desktop WebView. Android's WebView reports no env()
 * safe-area insets, so the app hands them over as the --app-safe-* variables the renderer's
 * `.app-layout` pads by, and the page reports its theme back so the system bar icons stay legible.
 */

export type EdgeInsets = { top: number; right: number; bottom: number; left: number }

const THEME_MESSAGE_TYPE = 'orca-desktop-theme'

export function buildSafeAreaScript(insets: EdgeInsets): string {
  const assignments = (['top', 'right', 'bottom', 'left'] as const)
    .map(
      (side) => `s.setProperty('--app-safe-${side}','${Math.max(0, Math.round(insets[side]))}px');`
    )
    .join('')
  // Trailing `true`: injected scripts must evaluate to a serializable value on Android.
  return `(function(){var s=document.documentElement.style;${assignments}})();true;`
}

/** Posts `{type, dark}` now and whenever the renderer flips the root `dark` class. */
export const THEME_REPORTER_SCRIPT = `(function(){
  function report(){
    if(!window.ReactNativeWebView){return;}
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'${THEME_MESSAGE_TYPE}',dark:document.documentElement.classList.contains('dark')}));
  }
  new MutationObserver(report).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  document.addEventListener('DOMContentLoaded',report);
  report();
})();true;`

/** Null for anything that is not a well-formed theme report; the page is not trusted beyond that. */
export function parseThemeMessage(data: string): boolean | null {
  try {
    const message: unknown = JSON.parse(data)
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === THEME_MESSAGE_TYPE &&
      'dark' in message &&
      typeof message.dark === 'boolean'
    ) {
      return message.dark
    }
  } catch {
    // Not JSON: not ours.
  }
  return null
}
