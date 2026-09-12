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

  // The good case: daemon answers hello AND the PTY spawn probe succeeds.
  it('HEALTHY: a daemon that can spawn PTYs classifies as healthy', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      ptySpawnHealthCheck: vi.fn(async () => {}),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    try {
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('healthy')
    } finally {
      await server.shutdown()
    }
  })

  // Symptom B, degraded: this is the case #6830 RESCUES. The daemon answers
  // protocol but its PTY spawn probe throws (deleted cwd / stale native PTY
  // after an upgrade), so fresh terminals would open frozen with no cursor.
  it('DEGRADED: protocol-alive daemon that cannot spawn PTYs classifies as pty-spawn-unhealthy', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      ptySpawnHealthCheck: vi.fn(async () => {
        throw new Error('chdir(2) failed.: No such file or directory')
      }),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    try {
      // -> #6830 marks this daemon degraded and routes fresh spawns to the
      //    local provider instead of the no-cursor daemon pane.
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('pty-spawn-unhealthy')
    } finally {
      await server.shutdown()
    }
  })

  // Regression for #6866 follow-up: a DEGRADED daemon whose PTY spawn probe is
  // slow (busy machine right after an upgrade) but still settles must classify
  // as 'pty-spawn-unhealthy' so the degraded fallback engages — NOT as
  // 'unreachable'. The PR raised the server probe budget (2s->4s, +1 retry, up
  // to ~8s) but left the client health-check timeout unchanged, so a probe that
  // settled past the client budget was mis-bucketed as 'unreachable' and the
  // degraded rescue never ran (fresh terminals froze on a no-cursor daemon).
  it('DEGRADED (slow probe): a protocol-alive daemon whose PTY probe settles after the old 3s budget still classifies as pty-spawn-unhealthy', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      // Why: simulate one slow probe on a busy machine that settles in the
      // 3-4s window — past the old 3000ms client budget but well within the
      // server's post-diff per-probe budget.
      ptySpawnHealthCheck: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('chdir(2) failed.: No such file or directory')), 3_500)
          })
      ),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    try {
      // -> the client must wait long enough to receive the degraded reply and
      //    mark the daemon degraded, so fresh spawns route to the local
      //    provider instead of the no-cursor daemon pane.
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('pty-spawn-unhealthy')
    } finally {
      await server.shutdown()
    }
  }, 15000)

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

  // No daemon at all (or token missing) -> unreachable.
  it('UNREACHABLE: no daemon listening classifies as unreachable', async () => {
    await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('unreachable')
  })
})
