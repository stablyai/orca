type DiagnosticConsole = Pick<Console, 'debug' | 'error' | 'info' | 'log'>

export function reserveServeStdoutForReadiness(target: DiagnosticConsole = console): void {
  // Why: stdout is the serve readiness API; route incidental diagnostics to stderr so JSON stays parseable.
  const writeDiagnostic = target.error.bind(target)
  target.debug = writeDiagnostic
  target.info = writeDiagnostic
  target.log = writeDiagnostic
}
