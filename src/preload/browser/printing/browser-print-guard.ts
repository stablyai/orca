/**
 * Runs serialized in the page's main world. Electron's `print()` opens the system print dialog,
 * which takes the foreground, so main may refuse it; a refused call returns like a throttled one.
 */
export function installBrowserPrintGuard(mayOpen: () => boolean): void {
  const print = window.print
  try {
    window.print = () => {
      if (mayOpen()) {
        print.call(window)
      }
    }
  } catch {}
}
