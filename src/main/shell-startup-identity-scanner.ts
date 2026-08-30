export const SHELL_STARTUP_IDENTITY_PREFIX = '\x1b]777;orca-shell-start:'
export const SHELL_STARTUP_IDENTITY_V2_PREFIX = '\x1b]777;orca-shell-start;v2;'
const POSSIBLE_PID_SUFFIX = /^\d{0,20}$/

export type ShellStartupIdentityScanState = {
  heldBytes: string
}

export type ShellStartupIdentityScanResult = {
  output: string
  shellPid: number | null
  shellStartTime?: string
  tty?: string
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
  if (
    SHELL_STARTUP_IDENTITY_PREFIX.startsWith(candidate) ||
    SHELL_STARTUP_IDENTITY_V2_PREFIX.startsWith(candidate)
  ) {
    return true
  }
  if (candidate.startsWith(SHELL_STARTUP_IDENTITY_PREFIX)) {
    return POSSIBLE_PID_SUFFIX.test(candidate.slice(SHELL_STARTUP_IDENTITY_PREFIX.length))
  }
  return (
    candidate.startsWith(SHELL_STARTUP_IDENTITY_V2_PREFIX) &&
    !candidate.includes('\x07') &&
    candidate.length < 512
  )
}

function parseV2(payload: string): Omit<ShellStartupIdentityScanResult, 'output'> | null {
  const [pidText, shellStartTime, ttyBase64, ...extra] = payload.split(';')
  const shellPid = Number(pidText)
  if (
    extra.length > 0 ||
    !/^\d+$/.test(pidText ?? '') ||
    !Number.isSafeInteger(shellPid) ||
    shellPid <= 0 ||
    !/^\d*$/.test(shellStartTime ?? '') ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ttyBase64 ?? '')
  ) {
    return null
  }
  try {
    return {
      shellPid,
      ...(shellStartTime ? { shellStartTime } : {}),
      ...(ttyBase64
        ? {
            tty: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(ttyBase64, 'base64'))
          }
        : {})
    }
  } catch {
    return null
  }
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
    if (candidate.startsWith(SHELL_STARTUP_IDENTITY_V2_PREFIX)) {
      const suffix = candidate.slice(SHELL_STARTUP_IDENTITY_V2_PREFIX.length)
      const terminator = suffix.indexOf('\x07')
      const parsed = terminator === -1 ? null : parseV2(suffix.slice(0, terminator))
      if (parsed) {
        const markerLength = SHELL_STARTUP_IDENTITY_V2_PREFIX.length + terminator + 1
        return { output: output + candidate.slice(markerLength), ...parsed }
      }
    } else if (candidate.startsWith(SHELL_STARTUP_IDENTITY_PREFIX)) {
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
