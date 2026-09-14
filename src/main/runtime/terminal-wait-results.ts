import type {
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import { isProvenProcessExit, type TerminalExitCause } from '../../shared/terminal-exit-cause'

type ReadonlyTerminalStateRecord = {
  connected: boolean
  lastExitCode: number | null
  lastExitCause?: TerminalExitCause | null
}

export function getTerminalState(leaf: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  // Why isProvenProcessExit and not `!== null`: a disconnect stamps the unverified sentinel
  // (-1) into lastExitCode too, and that is contact lost, not a death certificate.
  if (leaf.lastExitCode !== null && isProvenProcessExit(leaf.lastExitCode)) {
    return 'exited'
  }
  return 'unknown'
}

export function buildTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    undefined,
    leaf.lastExitCause
  )
}

export function buildTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    blockedReason,
    leaf.lastExitCause
  )
}

export function buildPtyTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    undefined,
    pty.lastExitCause
  )
}

export function buildPtyTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    blockedReason,
    pty.lastExitCause
  )
}

export function buildTerminalWait(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  status: RuntimeTerminalState,
  exitCode: number | null,
  blockedReason?: RuntimeTerminalWaitBlockedReason,
  exitCause?: TerminalExitCause | null
): RuntimeTerminalWait {
  return {
    handle,
    condition,
    satisfied: blockedReason === undefined,
    status,
    exitCode,
    ...(exitCause ? { exitCause } : {}),
    ...(blockedReason ? { blockedReason } : {})
  }
}

export function getPtyTerminalState(pty: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  if (pty.connected) {
    return 'running'
  }
  return pty.lastExitCode !== null && isProvenProcessExit(pty.lastExitCode) ? 'exited' : 'unknown'
}
