/** What a `ptySpawnHealth` reply proves on this platform. */
export function ptySpawnHealthPlatformCoverage(): 'pty-spawn' | 'handshake' {
  // Why handshake on Windows: preflightPtySpawnHealth skips the spawn probe there.
  return process.platform === 'win32' ? 'handshake' : 'pty-spawn'
}
