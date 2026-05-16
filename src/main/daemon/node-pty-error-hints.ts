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
  11, // EAGAIN on Linux
  12, // ENOMEM
  23, // ENFILE on macOS
  24, // EMFILE on macOS/Linux
  35 // EAGAIN on macOS
])

const PTY_ALLOCATION_HINT = [
  'Your system cannot allocate any more pty devices.',
  '',
  'Orca requires a pty device to launch a new terminal. This error is usually due to having too many terminal windows or terminal sessions open, either in Orca or another program.',
  '',
  'Free up some pty devices and try again.'
].join('\n')

const TERMINAL_PROCESS_LIMIT_HINT = [
  'Your system cannot start another terminal process.',
  '',
  'This is usually due to having too many terminal sessions or other processes running.',
  '',
  'Close unused terminals or quit unused processes and try again.'
].join('\n')

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

export function addNodePtyRecoveryHint(message: string): string {
  const diagnostic = parseNodePtyDiagnostic(message)
  if (!diagnostic) {
    if (GENERIC_PTY_ALLOCATION_RE.test(message) && !message.startsWith(PTY_ALLOCATION_HINT)) {
      return `${PTY_ALLOCATION_HINT} ${message}`
    }
    return message
  }

  const hint = getNodePtyRecoveryHint(diagnostic)
  if (hint && message.startsWith(hint)) {
    return message
  }
  return hint ? `${hint} ${message}` : message
}
