export type NodePtyDiagnostic = {
  step: string
  errno: number
}

const NODE_PTY_DIAGNOSTIC_RE = /^node-pty: ([A-Za-z0-9_]+) failed: .*?\(errno (\d+)(?:, [^)]*)?\)/

export function parseNodePtyDiagnostic(message: string): NodePtyDiagnostic | null {
  const match = NODE_PTY_DIAGNOSTIC_RE.exec(message)
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
  if (diagnostic.step === 'open_slave' && diagnostic.errno === 24) {
    return 'Daemon hit the file-descriptor limit. Restart the daemon.'
  }
  if (diagnostic.step === 'posix_spawn' && diagnostic.errno === 35) {
    return 'Per-user process limit reached. Quit some agents and retry.'
  }
  return null
}

export function addNodePtyRecoveryHint(message: string): string {
  const diagnostic = parseNodePtyDiagnostic(message)
  if (!diagnostic) {
    return message
  }

  const hint = getNodePtyRecoveryHint(diagnostic)
  return hint ? `${hint} ${message}` : message
}
