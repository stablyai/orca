import { writeSync } from 'node:fs'

export const STARTUP_DIAGNOSTICS_ENV = 'ORCA_STARTUP_DIAGNOSTICS'

export type StartupDiagnosticSink = (fd: number, text: string) => unknown

export function writeStartupDiagnosticLine(
  message: string,
  write: StartupDiagnosticSink = writeSync
): void {
  try {
    write(2, message.endsWith('\n') ? message : `${message}\n`)
  } catch {
    console.error(message)
  }
}

export function isStartupDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STARTUP_DIAGNOSTICS_ENV] === '1'
}

export function logStartupDiagnostic(
  event: string,
  details: Record<string, unknown> = {},
  write?: StartupDiagnosticSink
): void {
  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')
  writeStartupDiagnosticLine(`[startup] ${event}${detailText ? ` ${detailText}` : ''}`, write)
}

// Why: startup benchmarking needs in-process timestamps — harness-side stderr
// arrival times include pipe buffering jitter. `t` is ms since process start.
export function logStartupMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}
