import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, connect, type Server } from 'net'
import { DaemonServer } from './daemon-server'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import {
  getProcessStartedAtMs,
  healthCheckDaemon,
  killStaleDaemon,
  parseDaemonPidFile,
  startTimeMatches
} from './daemon-health'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

describe('daemon health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes when a daemon answers ping', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(true)
    } finally {
      await server.shutdown()
    }
  })

  it('fails when the token file is missing', async () => {
    await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
  })

  it('does not unlink a live socket when the pid file does not match this daemon', async () => {
    if (process.platform === 'win32') {
      return
    }

    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    writeFileSync(getDaemonPidPath(dir), String(process.pid), { mode: 0o600 })

    try {
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
      await expect(canConnect(socketPath)).resolves.toBe(true)
    } finally {
      await closeServer(server)
    }
  })
})

describe('parseDaemonPidFile', () => {
  it('parses JSON pid files with startedAtMs', () => {
    const serialized = serializeDaemonPidFile({ pid: 12345, startedAtMs: 1_700_000_000_000 })
    expect(parseDaemonPidFile(serialized)).toEqual({
      pid: 12345,
      startedAtMs: 1_700_000_000_000
    })
  })

  it('accepts JSON with startedAtMs missing and returns null for it', () => {
    // Why: forward-compatible with hypothetical future daemons that might write
    // pid without startedAtMs (platform where getProcessStartedAtMs returns null).
    expect(parseDaemonPidFile('{"pid":9999}')).toEqual({ pid: 9999, startedAtMs: null })
  })

  it('falls back to bare-integer parsing for legacy pid files', () => {
    // Why: pre-Phase-0 daemons wrote the pid file as a bare integer.
    // parseDaemonPidFile must still accept those to avoid leaking a stale
    // daemon across a single upgrade boundary.
    expect(parseDaemonPidFile('12345')).toEqual({ pid: 12345, startedAtMs: null })
    expect(parseDaemonPidFile('  12345\n')).toEqual({ pid: 12345, startedAtMs: null })
  })

  it('returns null for malformed input', () => {
    expect(parseDaemonPidFile('not-a-number')).toBeNull()
    expect(parseDaemonPidFile('{"pid":"abc"}')).toBeNull()
    expect(parseDaemonPidFile('{"not_pid":123}')).toBeNull()
  })
})

describe('startTimeMatches', () => {
  it('returns true when expected is null (legacy pid file)', () => {
    // The real process pid is irrelevant here — null short-circuits before
    // getProcessStartedAtMs is consulted.
    expect(startTimeMatches(process.pid, null)).toBe(true)
  })

  it('returns true when actual start time cannot be read (fail-open)', () => {
    if (process.platform === 'win32') {
      // Windows always returns null from getProcessStartedAtMs, which is the
      // fail-open case we want.
      expect(startTimeMatches(process.pid, 1_700_000_000_000)).toBe(true)
      return
    }
    // Pid 0 is the kernel scheduler — ps -p 0 / /proc/0 both fail, so
    // getProcessStartedAtMs returns null and the check fails open.
    expect(startTimeMatches(0, 1_700_000_000_000)).toBe(true)
  })

  it('returns true for matching start time within tolerance', () => {
    if (process.platform === 'win32') {
      // Skip on Windows — getProcessStartedAtMs always returns null.
      return
    }
    const actual = getProcessStartedAtMs(process.pid)
    if (actual === null) {
      // Platform can't probe — skip
      return
    }
    // Tolerance is ±1500ms. Shift expected by 500ms, still within tolerance.
    expect(startTimeMatches(process.pid, actual + 500)).toBe(true)
  })

  it('returns false for start times outside tolerance', () => {
    if (process.platform === 'win32') {
      return
    }
    const actual = getProcessStartedAtMs(process.pid)
    if (actual === null) {
      return
    }
    // Shift expected by 10s — clearly outside the ±1500ms tolerance.
    expect(startTimeMatches(process.pid, actual + 10_000)).toBe(false)
  })
})

describe('killStaleDaemon pid identity guards', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-pid-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not SIGTERM when the saved startedAtMs mismatches the current process', async () => {
    if (process.platform === 'win32') {
      return
    }

    // Why: seed a pid file that claims the daemon is `process.pid` (us) but
    // was started 1 hour ago. Our real start time is "now," so startTimeMatches
    // returns false and isDaemonProcess rejects. killStaleDaemon must not call
    // process.kill in that case.
    const bogusStartedAtMs = Date.now() - 60 * 60 * 1000
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: bogusStartedAtMs }),
      { mode: 0o600 }
    )

    // isDaemonProcess uses process.kill(pid, 0) as a liveness probe; that's
    // expected and not a real kill. We only care that no actual termination
    // signal is sent.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toBe(false)
      const terminationSignals = killSpy.mock.calls.filter(
        ([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'
      )
      expect(terminationSignals).toEqual([])
    } finally {
      killSpy.mockRestore()
    }
  })
})
