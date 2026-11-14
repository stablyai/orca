import type { BrowserIdentityModeStatus } from '../../shared/browser-user-agent-mode'

type DiagnosticConsole = Pick<Console, 'debug' | 'error' | 'info' | 'log' | 'warn'>
type StderrTarget = Pick<NodeJS.WriteStream, 'write'>

export function reserveServeStdoutForReadiness(
  target: DiagnosticConsole = console,
  now: () => Date = () => new Date()
): void {
  // Stamp each diagnostic so headless logs line up with daemon and kernel logs (#40328).
  const stamped =
    (write: (...args: unknown[]) => void) =>
    (...args: unknown[]): void =>
      write(now().toISOString(), ...args)
  const writeWarning = stamped(target.warn.bind(target))
  // Why: stdout is the serve readiness API; route incidental diagnostics to stderr so JSON stays parseable.
  const writeDiagnostic = stamped(target.error.bind(target))
  target.warn = writeWarning
  target.error = writeDiagnostic
  target.debug = writeDiagnostic
  target.info = writeDiagnostic
  target.log = writeDiagnostic
}

export function emitServeBrowserIdentityActionLine(
  status: BrowserIdentityModeStatus,
  target: StderrTarget = process.stderr
): void {
  let action: string | null = null
  if (status.identity.state === 'future') {
    action = 'browser identity data is from a newer version; update Orca'
  } else if (status.identity.state === 'corrupt' || status.identity.state === 'unreadable') {
    action = `browser identity data is ${status.identity.state}; reset it explicitly`
  } else if (status.migrationNotice?.degraded) {
    action = 'an old choice could not be inspected; choose Cleaned or Native'
  } else if (status.migrationNotice) {
    action = 'browser identity changed to app-wide; choose Cleaned or Native'
  }
  if (action) {
    target.write(`[browser-identity] action required: ${action}\n`)
  }
}
