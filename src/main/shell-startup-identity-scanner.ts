import type { WslShellProcessAnchor } from '../shared/wsl-shell-process-anchor'

export const SHELL_STARTUP_IDENTITY_PREFIX = '\x1b]777;orca-shell-start:'
const POSSIBLE_V2_SUFFIX = /^v2(?::[A-Za-z0-9._/:-]{0,220})?$/
const POSSIBLE_PID_SUFFIX = /^\d{0,20}$/

export type ShellStartupIdentityScanState = {
  heldBytes: string
}

export type ShellStartupIdentityScanResult = {
  output: string
  shellPid: number | null
  /** Full WSL identity; legacy PID-only markers intentionally do not qualify. */
  shellIdentity?: WslShellProcessAnchor
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
  return POSSIBLE_PID_SUFFIX.test(suffix) || POSSIBLE_V2_SUFFIX.test(suffix)
}

function parseIdentitySuffix(suffix: string): WslShellProcessAnchor | null {
  const fields = suffix.split(':')
  if (fields.length !== 6 || fields[0] !== 'v2') {
    return null
  }
  const [, distro, bootId, pidText, startText, tty] = fields
  if (
    !distro ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(distro) ||
    !bootId ||
    !/^[A-Fa-f0-9-]{8,128}$/.test(bootId) ||
    !/^\d{1,20}$/.test(pidText ?? '') ||
    !/^\d{1,30}$/.test(startText ?? '') ||
    !/^\/dev\/pts\/\d{1,8}$/.test(tty ?? '')
  ) {
    return null
  }
  const shellPid = Number(pidText)
  const shellStartTime = Number(startText)
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0) {
    return null
  }
  if (!Number.isSafeInteger(shellStartTime) || shellStartTime < 0) {
    return null
  }
  return { distro, bootId, shellPid, shellStartTime, tty: tty! }
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
      const identity = parseIdentitySuffix(terminator === -1 ? suffix : suffix.slice(0, terminator))
      if (identity) {
        const markerLength = SHELL_STARTUP_IDENTITY_PREFIX.length + terminator + 1
        return {
          output: output + candidate.slice(markerLength),
          shellPid: identity.shellPid,
          shellIdentity: identity
        }
      }
    }
    output += candidate[0]
    pending = candidate.slice(1)
  }

  return { output, shellPid: null }
}
