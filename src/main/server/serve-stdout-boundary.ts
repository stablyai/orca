import type { BrowserIdentityModeStatus } from '../../shared/browser-user-agent-mode'

type DiagnosticConsole = Pick<Console, 'debug' | 'error' | 'info' | 'log'>
type StderrTarget = Pick<NodeJS.WriteStream, 'write'>

export function reserveServeStdoutForReadiness(target: DiagnosticConsole = console): void {
  // Why: stdout is the serve readiness API; route incidental diagnostics to stderr so JSON stays parseable.
  const writeDiagnostic = target.error.bind(target)
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
  } else if (
    status.identity.state === 'corrupt' ||
    status.identity.state === 'unreadable'
  ) {
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
