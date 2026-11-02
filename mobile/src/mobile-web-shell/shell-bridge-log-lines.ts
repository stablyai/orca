import type { BridgeHostDiagnostic } from './bridge-host-contract'
import type { ShellLifecycleLine } from './shell-lifecycle-line-recorder'
import { maskUserText } from './shell-log-path-masking'

/** Bridge-side shell log lines: host diagnostics and frames that found no host to answer them. */

/** Null for routine kinds; the caller already bounds each key to one line per host. */
export function bridgeDiagnosticLine(diagnostic: BridgeHostDiagnostic): ShellLifecycleLine | null {
  // Retired terminal streams are routine and one per stream; they would crowd out the log.
  if (diagnostic.kind === 'terminal-backlog') {
    return null
  }
  const detail = bridgeDiagnosticDetail(diagnostic)
  return {
    level: 'warn',
    code: 'web-shell-bridge',
    message: `Web shell bridge: ${diagnostic.kind}`,
    ...(detail === undefined ? {} : { detail })
  }
}

/** A page frame arrived while no bridge host was built, so it was dropped unanswered. */
export function frameWithoutHostLine(facts: {
  clientReady: boolean
  snapshotReady: boolean
}): ShellLifecycleLine {
  return {
    level: 'warn',
    code: 'web-shell-page',
    message: 'Web shell: page frame with no bridge host',
    detail: `client=${facts.clientReady ? 'ok' : 'null'} snapshot=${facts.snapshotReady ? 'ok' : 'null'}`
  }
}

function bridgeDiagnosticDetail(diagnostic: BridgeHostDiagnostic): string | undefined {
  switch (diagnostic.kind) {
    case 'refused':
      return diagnostic.refusal
    case 'notify-refused':
    case 'navigate-back-refused':
      return diagnostic.why
    case 'post-failed':
      return `error=${maskUserText(errorName(diagnostic.error))}`
    case 'route-refused':
      return `issue=${maskUserText(diagnostic.issue)}`
    case 'notify-failed':
    case 'frame-after-dispose':
    case 'frame-after-close':
    case 'storage-refused':
    case 'route-update-refused':
    case 'binary-lane-refused':
    case 'binary-frame-dropped':
    case 'terminal-backlog':
      // Their payloads name keys, ids or schema text that is not needed to place a stall.
      return undefined
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
