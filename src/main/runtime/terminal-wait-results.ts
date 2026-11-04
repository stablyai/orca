import type {
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import type { TerminalExitCause } from '../../shared/terminal/pty/lifecycle/terminal-exit-cause'

type ReadonlyTerminalStateRecord = {
  connected: boolean
  lastExitCode: number | null
  lastExitCause?: TerminalExitCause | null
}

export function buildPtyTerminalWaitExitError(pty: ReadonlyTerminalStateRecord): Error {
  return Object.assign(new Error('terminal_exited'), { terminalExitCause: pty.lastExitCause })
}

/** The process exit a terminal wait error proves; operator closes and unreported causes prove nothing. */
export function readProvenTerminalExit(error: unknown): TerminalExitCause | null {
  const cause =
    error instanceof Error && error.message === 'terminal_exited' && 'terminalExitCause' in error
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyTerminalWaitExitError attaches the PTY's recorded cause.
        (error.terminalExitCause as TerminalExitCause | null | undefined)
      : null
  return cause?.kind === 'exited' || cause?.kind === 'signaled' ? cause : null
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
  return pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown'
}
