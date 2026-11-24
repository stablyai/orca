export const SHELL_STARTUP_IDENTITY_PREFIX = '\x1b]777;orca-shell-start:'
const POSSIBLE_PID_SUFFIX = /^\d{0,20}$/

export type ShellStartupIdentityScanState = {
  heldBytes: string
}

export type ShellStartupIdentityScanResult = {
  output: string
  shellPid: number | null
}

export function createShellStartupIdentityScanState(): ShellStartupIdentityScanState {
  return { heldBytes: '' }
}

export function drainShellStartupIdentityHeldBytes(state: ShellStartupIdentityScanState): string {
  const heldBytes = state.heldBytes
  state.heldBytes = ''
  return heldBytes
}

function isPossibleMarker(candidate: string): boolean {
  if (candidate.length <= SHELL_STARTUP_IDENTITY_PREFIX.length) {
    return SHELL_STARTUP_IDENTITY_PREFIX.startsWith(candidate)
  }
  if (!candidate.startsWith(SHELL_STARTUP_IDENTITY_PREFIX)) {
    return false
  }
  const suffix = candidate.slice(SHELL_STARTUP_IDENTITY_PREFIX.length)
  return POSSIBLE_PID_SUFFIX.test(suffix)
}

export function scanForShellStartupIdentity(
  state: ShellStartupIdentityScanState,
  data: string
): ShellStartupIdentityScanResult {
  let pending = state.heldBytes + data
  let output = ''
  state.heldBytes = ''

  while (pending.length > 0) {
    const start = pending.indexOf(SHELL_STARTUP_IDENTITY_PREFIX[0] as string)
    if (start === -1) {
      output += pending
      break
    }
    output += pending.slice(0, start)
    const candidate = pending.slice(start)
    if (isPossibleMarker(candidate)) {
      state.heldBytes = candidate
      break
    }
    if (candidate.startsWith(SHELL_STARTUP_IDENTITY_PREFIX)) {
      const suffix = candidate.slice(SHELL_STARTUP_IDENTITY_PREFIX.length)
      const terminator = suffix.indexOf('\x07')
      const pidText = terminator === -1 ? '' : suffix.slice(0, terminator)
      if (/^\d+$/.test(pidText)) {
        const shellPid = Number(pidText)
        const markerLength = SHELL_STARTUP_IDENTITY_PREFIX.length + terminator + 1
        return {
          output: output + candidate.slice(markerLength),
          shellPid: Number.isSafeInteger(shellPid) && shellPid > 0 ? shellPid : null
        }
      }
    }
    output += candidate[0]
    pending = candidate.slice(1)
  }

  return { output, shellPid: null }
}
