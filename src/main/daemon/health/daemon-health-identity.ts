export function ptySpawnHealthPlatformCoverage(): 'pty-spawn' | 'handshake' {
  // Windows preflight skips the PTY spawn probe.
  return process.platform === 'win32' ? 'handshake' : 'pty-spawn'
}
