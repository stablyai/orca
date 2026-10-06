import './mock-descendant-sweep'
// Regression coverage for issue #6814 (terminal lockup after upgrade).
//
// Drives the real DaemonServer + checkDaemonHealth client over a real unix
// socket to lock in how each post-upgrade daemon failure mode is classified,
// and therefore which ones the degraded-daemon fallback actually rescues:
//   - degraded (answers protocol, cannot spawn) -> pty-spawn-unhealthy -> rescued
//   - wedged   (event loop hung, health RPC never returns) -> unreachable -> NOT
//     rescued by the degraded provider; falls to the preserve-or-replace path.
// This boundary is load-bearing: the degraded fallback only helps a daemon that
// still answers protocol, so a regression that widened it to wedged daemons
// would silently strand fresh terminals on a daemon that cannot serve them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { checkDaemonHealth } from './daemon-health'
import type { SubprocessHandle } from './session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

function daemonTestSocketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(dir)}-daemon.sock`
    : join(dir, 'daemon.sock')
}

describe('issue #6814 repro: daemon failure-mode classification', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-6814-repro-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // The limit of #6830: a fully WEDGED daemon (event loop hung — health RPC
  // never returns) cannot be distinguished by a richer status. It times out
  // and classifies as 'unreachable', the SAME bucket as a dead daemon.
  it('WEDGED: a daemon whose health RPC never resolves classifies as unreachable (NOT degraded)', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      // Why: simulate a hung event loop — the probe never settles.
      ptySpawnHealthCheck: vi.fn(() => new Promise<void>(() => {})),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    try {
      const health = await checkDaemonHealth(socketPath, tokenPath)
      // This is the key finding: wedged != degraded. #6830's degraded fallback
      // does NOT engage here; recovery still depends on the unreachable-path
      // (grace-bounded preserve-if-live-else-replace) logic, not the degraded
      // provider.
      expect(health).toBe('unreachable')
    } finally {
      await server.shutdown()
    }
  }, 15000)

  // #8689: a daemon whose socket accepts connections but never answers the
  // hello handshake (event loop wedged before the protocol reply) also
  // classifies as 'unreachable' — the launcher's grace-bounded path must
  // eventually replace it rather than preserve it forever.
  it('WEDGED-HELLO: a daemon that accepts connections but never answers hello classifies as unreachable (#8689)', async () => {
    const wedged = createServer((sock) => {
      // Swallow the hello bytes but never write a response — the exact wedge.
      sock.on('data', () => {})
    })
    await new Promise<void>((resolve) => wedged.listen(socketPath, () => resolve()))
    // The health check reads the token before connecting, so it must exist.
    writeFileSync(tokenPath, 'wedged-token')
    try {
      const health = await checkDaemonHealth(socketPath, tokenPath)
      expect(health).toBe('unreachable')
    } finally {
      await new Promise<void>((resolve) => wedged.close(() => resolve()))
    }
  }, 15000)
})
