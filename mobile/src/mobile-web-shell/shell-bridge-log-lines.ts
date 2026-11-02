import type { BridgeHostDiagnostic } from './bridge-host-contract'
import type { ShellLifecycleLine } from './shell-lifecycle-line-recorder'
import { maskUserText } from './shell-log-path-masking'

// Return null for routine kinds; callers limit other diagnostic keys to one line per host.
export function bridgeDiagnosticLine(diagnostic: BridgeHostDiagnostic): ShellLifecycleLine | null {
  // Routine per-stream retirements would crowd out useful diagnostics.
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
      // Omit payload keys, ids and schema text that are unnecessary to locate a stall.
      return undefined
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
