import type { TerminalExitCause } from '../../../shared/terminal/pty/lifecycle/terminal-exit-cause'

/** node-pty reports code 0 for signal deaths, so `session-exited` needs the cause to tell them from clean exits. */
export function sessionExitCauseLogFields(
  cause: TerminalExitCause | undefined
): Record<string, string | number> {
  if (!cause) {
    return {}
  }
  if (cause.kind === 'signaled') {
    return { cause: cause.kind, signal: cause.signal }
  }
  return cause.kind === 'unknown'
    ? { cause: cause.kind, reason: cause.reason }
    : { cause: cause.kind }
}
