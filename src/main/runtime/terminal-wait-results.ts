import type {
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition,
  RuntimeTerminalReadiness
} from '../../shared/runtime-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

type ReadonlyTerminalStateRecord = {
  connected: boolean
  lastExitCode: number | null
  lastExitCause?: TerminalExitCause | null
}

export function getTerminalState(leaf: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  if (leaf.lastExitCode !== null) {
    return 'exited'
  }
  return 'unknown'
}

export function buildTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord,
  readiness?: RuntimeTerminalReadiness
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    undefined,
    leaf.lastExitCause,
    readiness
  )
}

export function buildTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason,
  readiness?: RuntimeTerminalReadiness
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    blockedReason,
    leaf.lastExitCause,
    readiness ?? { state: 'blocked', source: 'screen' }
  )
}

export function buildPtyTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord,
  readiness?: RuntimeTerminalReadiness
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    undefined,
    pty.lastExitCause,
    readiness
  )
}

export function buildPtyTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason,
  readiness?: RuntimeTerminalReadiness
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    blockedReason,
    pty.lastExitCause,
    readiness ?? { state: 'blocked', source: 'screen' }
  )
}

export function buildTerminalWait(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  status: RuntimeTerminalState,
  exitCode: number | null,
  blockedReason?: RuntimeTerminalWaitBlockedReason,
  exitCause?: TerminalExitCause | null,
  readiness?: RuntimeTerminalReadiness
): RuntimeTerminalWait {
  const satisfied =
    condition === 'tui-idle' && readiness
      ? readiness.state === 'ready'
      : blockedReason === undefined
  return {
    handle,
    condition,
    satisfied,
    status,
    exitCode,
    ...(exitCause ? { exitCause } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(readiness ? { readiness } : {})
  }
}

export function getPtyTerminalState(pty: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  return pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown'
}
