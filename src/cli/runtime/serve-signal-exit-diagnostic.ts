import { RuntimeClientError } from './types'

export const MAC_CRASH_REPORT_GLOB = '~/Library/Logs/DiagnosticReports/Orca-*.ips'

export function serveSignalExitError(
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform
): RuntimeClientError {
  if (!signal) {
    return new RuntimeClientError(
      'runtime_serve_failed',
      'Orca serve exited without reporting an exit code or signal.'
    )
  }
  if (platform !== 'darwin' || signal !== 'SIGABRT') {
    return new RuntimeClientError('runtime_serve_failed', `Orca serve exited via ${signal}.`)
  }
  // Why: the startup abort happens inside +[NSApplication sharedApplication], before any of our JS
  // runs, so the parent CLI is the only place it can be explained. We only see the signal, never the
  // phase, so the cause is offered as the likely one rather than asserted.
  return new RuntimeClientError(
    'runtime_serve_failed',
    'Orca serve aborted with SIGABRT on macOS. This most often happens at application startup, when the process cannot register with Launch Services (_RegisterApplication / +[NSApplication sharedApplication]) before any Orca JavaScript runs. That is common in sandboxed agent environments, SSH sessions without a GUI login, and CI. Confirm the crashing frame in the crash report; this is not the Electron UTF-8 write abort (electron/electron#51871).',
    {
      nextSteps: [
        'If a desktop Orca is already running, use `orca status` / `orca` against that instance instead of `orca serve`.',
        'Do not exec /Applications/Orca.app/Contents/MacOS/Orca from a sandbox. Leave the sandbox and re-run from a normal macOS desktop login. `open -a Orca` is not a sandbox workaround.',
        `Look for a crash report at ${MAC_CRASH_REPORT_GLOB}. If the crashing frame is _RegisterApplication, this is the startup-registration abort.`
      ]
    }
  )
}
