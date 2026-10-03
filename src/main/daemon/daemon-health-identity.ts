/** What a `ptySpawnHealth` reply proves about this daemon; every field is optional on the wire. */
export function readDaemonHealthIdentity(): {
  coverage: 'pty-spawn' | 'handshake'
  runtimeKind: 'node'
  runtimeVersion: string
} {
  return {
    // Why handshake on Windows: preflightPtySpawnHealth skips the spawn probe there.
    coverage: process.platform === 'win32' ? 'handshake' : 'pty-spawn',
    runtimeKind: 'node',
    runtimeVersion: process.version
  }
}
