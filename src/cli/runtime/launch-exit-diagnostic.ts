import { basename } from 'node:path'
import { RuntimeClientError } from './types'

// The parent only ever sees the signal, so the cause is offered as the likely
// one rather than asserted; the crash report in the next steps confirms it.
const MAC_ABORT_CAUSE =
  'aborted with SIGABRT on macOS before any Orca JavaScript ran. That is almost always the Electron main creating NSApplication: _RegisterApplication calls abort() when Launch Services is unreachable — common in sandboxed agent environments, SSH sessions without a GUI login, and CI. Retrying cannot help in that case: the abort happens before Orca can run, so every attempt fails identically.'

/**
 * Why: macOS names crash reports after the executing binary, so a packaged run
 * writes `Orca-*.ips` while a source/dev run writes `Electron-*.ips`. Pointing
 * at the wrong one sends people looking for a file that does not exist.
 */
export function macCrashReportGlob(
  executablePath: string = process.env.ORCA_APP_EXECUTABLE ?? process.execPath
): string {
  const processName = basename(executablePath).trim() || 'Orca'
  return `~/Library/Logs/DiagnosticReports/${processName}-*.ips`
}

function macAbortNextSteps(): string[] {
  return [
    'Re-run with an active macOS desktop login, outside the sandbox or restricted environment.',
    'If this is an automated sandbox, allow mach-lookup for com.apple.lsd.* and com.apple.coreservices.launchservicesd.',
    `Look for a crash report at ${macCrashReportGlob()}; its faulting stack ends in _RegisterApplication.`
  ]
}

function isMacStartupAbort(signal: NodeJS.Signals | null, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && signal === 'SIGABRT'
}

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
  if (!isMacStartupAbort(signal, platform)) {
    return new RuntimeClientError('runtime_serve_failed', `Orca serve exited via ${signal}.`)
  }
  return new RuntimeClientError('runtime_serve_failed', `Orca serve ${MAC_ABORT_CAUSE}`, {
    nextSteps: macAbortNextSteps()
  })
}

/**
 * Why: `orca open` spawns the desktop app detached, so a pre-JS abort used to
 * surface only as a 15s "timed out waiting for a window" — a diagnostic that
 * blames the wrong thing and invites a retry loop.
 */
export function openLaunchExitError(
  exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string },
  platform: NodeJS.Platform = process.platform
): RuntimeClientError {
  if (exit.spawnError) {
    // Why: nothing ran, so none of the abort guidance applies — the executable
    // or its working directory is what the user has to fix.
    return new RuntimeClientError('runtime_open_failed', `Could not start Orca: ${exit.spawnError}`)
  }
  if (isMacStartupAbort(exit.signal, platform)) {
    return new RuntimeClientError('runtime_open_failed', `Orca ${MAC_ABORT_CAUSE}`, {
      nextSteps: macAbortNextSteps()
    })
  }
  const how = exit.signal ? `via ${exit.signal}` : `with exit code ${exit.code}`
  return new RuntimeClientError(
    'runtime_open_failed',
    `Orca exited ${how} while starting up, before a desktop window appeared.`
  )
}
