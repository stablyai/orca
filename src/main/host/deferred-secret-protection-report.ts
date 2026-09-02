import { app, type BrowserWindow } from 'electron'
import { reportSecretProtectionGap } from './secret-protection-report'

/**
 * Run the at-rest secret protection report once the app is up, never before.
 *
 * Why deferred: `describeProtectionGap()` asks Electron `safeStorage` whether the OS
 * keyring is usable, and on Linux that is a blocking D-Bus round trip to
 * `org.freedesktop.secrets`. A keyring that is present but locked with no unlock
 * prompter never answers, so the call sits until D-Bus times it out — measured at 76s
 * to first window on Ubuntu 24.04, against 1s on the build before the report existed
 * (STA-5765). Run before the first window, that reads to the user as "the app will not
 * open"; the window is gated behind a diagnostic whose result nothing on the startup
 * path consumes.
 *
 * Why every platform and not just Linux: deferring costs nothing here — no caller reads the
 * result, so the only thing that moves is when a console line appears. macOS pays the same
 * shape against the Keychain, and a probe that has to answer before a window exists is wrong
 * on any host. A deferral that withholds a real secret has to be scoped to the platform that
 * needs it; this one withholds nothing.
 */

// Why a fallback as well as the window event: `ready-to-show` can fail to fire at all
// when the GPU/driver cannot present (see main-window-state-lifecycle), and headless
// serve has no window to wait on.
const REPORT_FALLBACK_MS = 15_000

export function scheduleSecretProtectionGapReport({
  deferUntilFirstWindow,
  skipInDevelopment = false,
  ...options
}: {
  dataFile: string
  force?: boolean
  log?: (message: string) => void
  /**
   * Why headless serve reports inline instead: it never opens a window, so the fallback
   * timer is the only path — and by then the runtime has been advertised as ready and
   * clients may have paired. Freezing the main thread under a live client stalls pings
   * and PTY pumps, which reads as a dead host. Blocking before anything is advertised is
   * the timing serve already had, and the safer of the two.
   */
  deferUntilFirstWindow: boolean
  /** Development profiles are disposable/isolated and must not trigger OS keychain UI. */
  skipInDevelopment?: boolean
}): void {
  if (skipInDevelopment && !options.force) {
    return
  }

  if (!deferUntilFirstWindow) {
    reportSecretProtectionGap(options)
    return
  }

  // Why swallow here and not in reportSecretProtectionGap: deferred, this no longer runs on
  // whenReady's promise chain, where a throw was an unhandled rejection the app survives
  // (#9441). Off that chain it is an uncaughtException, and installUncaughtPipeErrorGuard
  // re-throws those fatally — killing the app over a diagnostic the module documents as
  // deliberately not fatal. Serve still reports inline and keeps the old posture.
  const report = (): void => {
    try {
      reportSecretProtectionGap(options)
    } catch (error) {
      try {
        ;(options.log ?? console.warn)(
          `[secrets] could not run the deferred protection report: ${String(error)}`
        )
      } catch {
        // A throwing log sink must not be what ends the process either.
      }
    }
  }

  let ran = false
  const run = (): void => {
    if (ran) {
      return
    }
    ran = true
    clearTimeout(fallback)
    // Why setImmediate: keep the blocking keyring probe off the event handler that
    // reveals the window, so the reveal paints first.
    setImmediate(report)
  }

  const fallback = setTimeout(run, REPORT_FALLBACK_MS)
  fallback.unref?.()
  app.once('browser-window-created', (_event: Electron.Event, window: BrowserWindow) => {
    window.once('ready-to-show', run)
  })
}
