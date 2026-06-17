import { createHash } from 'crypto'

function isWindowsNamedPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('\\\\?\\pipe\\')
}

export function normalizeDaemonSocketPath(socketPath: string): string {
  if (process.platform !== 'win32' || isWindowsNamedPipePath(socketPath)) {
    return socketPath
  }
  const suffix = createHash('sha256').update(socketPath).digest('hex').slice(0, 16)
  return `\\\\?\\pipe\\orca-terminal-host-${suffix}`
}
