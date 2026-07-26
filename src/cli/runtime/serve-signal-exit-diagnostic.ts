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
    'Orca serve aborted with SIGABRT on macOS. This most often happens at application startup, when the process cannot register with the macOS window server, which is common in restricted or sandboxed environments, SSH sessions without a GUI login, and CI.',
    {
      nextSteps: [
        'Re-run `orca serve` outside a sandboxed or restricted environment, with a macOS desktop login active.',
        `Look for a crash report at ${MAC_CRASH_REPORT_GLOB}.`
      ]
    }
  )
}
