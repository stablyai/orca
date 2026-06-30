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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { checkDaemonHealth } from './daemon-health'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
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
      // (preserve-if-live-else-replace) logic, not the degraded provider.
      expect(health).toBe('unreachable')
    } finally {
      await server.shutdown()
    }
  }, 15000)

  // No daemon at all (or token missing) -> unreachable.
  it('UNREACHABLE: no daemon listening classifies as unreachable', async () => {
    await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('unreachable')
  })
})
