import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_PROCESS_LIMIT_HINT
} from '../../shared/terminal-spawn-error-copy'

export type NodePtyDiagnostic = {
  step: string
  errno: number
}

const NODE_PTY_DIAGNOSTIC_RE = /^node-pty: ([A-Za-z0-9_]+) failed: .*?\(errno (\d+)(?:, [^)]*)?\)/
const NODE_PTY_DIAGNOSTIC_ANYWHERE_RE =
  /node-pty: ([A-Za-z0-9_]+) failed: .*?\(errno (\d+)(?:, [^)]*)?\)/
const GENERIC_PTY_ALLOCATION_RE = /\b(?:openpty|forkpty)\(3\) failed\b/i

const PTY_ALLOCATION_STEPS = new Set([
  'posix_openpt',
  'grantpt',
  'unlockpt',
  'ioctl_TIOCPTYGNAME',
  'open_slave'
])

const RESOURCE_EXHAUSTION_ERRNOS = new Set([
  6, // ENXIO on macOS: posix_openpt could not provide a usable pty device
  11, // EAGAIN on Linux
  12, // ENOMEM
  23, // ENFILE on macOS
  24, // EMFILE on macOS/Linux
  35 // EAGAIN on macOS
])

export function parseNodePtyDiagnostic(message: string): NodePtyDiagnostic | null {
  const match =
    NODE_PTY_DIAGNOSTIC_RE.exec(message) ?? NODE_PTY_DIAGNOSTIC_ANYWHERE_RE.exec(message)
  if (!match) {
    return null
  }

  return {
    step: match[1],
    errno: Number(match[2])
  }
}

export function getNodePtyRecoveryHint(diagnostic: NodePtyDiagnostic): string | null {
  if (diagnostic.step === 'posix_spawn' && diagnostic.errno === 2) {
    return "Daemon's node-pty install is gone (worktree deleted?). Restart Orca."
  }
  if (
    PTY_ALLOCATION_STEPS.has(diagnostic.step) &&
    RESOURCE_EXHAUSTION_ERRNOS.has(diagnostic.errno)
  ) {
    return PTY_ALLOCATION_HINT
  }
  if (diagnostic.step === 'posix_spawn' && RESOURCE_EXHAUSTION_ERRNOS.has(diagnostic.errno)) {
    return TERMINAL_PROCESS_LIMIT_HINT
  }
  return null
}

function hasPtyAllocationHint(message: string): boolean {
  return message.startsWith(PTY_ALLOCATION_HINT) || message.startsWith(LEGACY_PTY_ALLOCATION_HINT)
}

export function addNodePtyRecoveryHint(message: string): string {
  const diagnostic = parseNodePtyDiagnostic(message)
  if (!diagnostic) {
    if (GENERIC_PTY_ALLOCATION_RE.test(message) && !hasPtyAllocationHint(message)) {
      return `${PTY_ALLOCATION_HINT}\n${message}`
    }
    return message
  }

  const hint = getNodePtyRecoveryHint(diagnostic)
  if (
    !hint ||
    message.startsWith(hint) ||
    (hint === PTY_ALLOCATION_HINT && hasPtyAllocationHint(message)) ||
    (hint === TERMINAL_PROCESS_LIMIT_HINT && message.startsWith(LEGACY_TERMINAL_PROCESS_LIMIT_HINT))
  ) {
    return message
  }
  // Older clients need both stale-daemon markers before their first-line IPC truncation.
  const separator =
    hint === PTY_ALLOCATION_HINT || hint === TERMINAL_PROCESS_LIMIT_HINT ? '\n' : ' '
  return `${hint}${separator}${message}`
}
