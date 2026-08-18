import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer, connect, type Server } from 'node:net'
import { DaemonServer } from './daemon-server'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import type { SocketProbeOutcome } from './daemon-endpoint-probe'
import {
  checkDaemonHealth,
  E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV,
  healthCheckDaemon
} from './daemon-health'
import { killStaleDaemon } from './daemon-stale-kill'
import {
  getProcessStartedAtMs,
  parseLinuxBootTimeSeconds,
  parseLinuxProcStartTicks,
  startTimeMatches,
  startTimesWithinTolerance
} from './daemon-process-start-time'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { parseWindowsProcessIdentityJson } from './daemon-process-identity-query'
import type { SubprocessHandle } from './session-subprocess-handle'

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

function daemonTestSocketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(dir)}-daemon.sock`
    : join(dir, 'daemon.sock')
}

describe('daemon health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-test-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes when a daemon answers ping', async () => {
    const ptySpawnHealthCheck = vi.fn(async () => {})
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      ptySpawnHealthCheck,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('healthy')
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(true)
      expect(ptySpawnHealthCheck).toHaveBeenCalledTimes(2)
    } finally {
      await server.shutdown()
    }
  })

  it('fails when a protocol-healthy daemon cannot spawn PTYs', async () => {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      ptySpawnHealthCheck: vi.fn(async () => {
        throw new Error('stale node-pty helper')
      }),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('pty-spawn-unhealthy')
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
    } finally {
      await server.shutdown()
    }
  })

  it('fails when the token file is missing', async () => {
    await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('unreachable')
    await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
  })

  it('returns unreachable when the e2e force-health-failure env is set', async () => {
    // Why: prove the e2e seam short-circuits even when a real daemon would
    // otherwise pass — not the already-covered missing-socket path.
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    vi.stubEnv(E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV, '1')
    try {
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('unreachable')
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
    } finally {
      vi.unstubAllEnvs()
      await server.shutdown()
    }
  })

  it('classifies a hello-rejected daemon as rejected, not unreachable', async () => {
    // Why: 'rejected' means the daemon answered and refused adoption — the
    // launcher may replace it. 'unreachable' also covers a wedged-but-live
    // daemon, which must never be replaced while its pipe accepts connections.
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()

    try {
      writeFileSync(tokenPath, 'not-the-daemon-token', { mode: 0o600 })
      await expect(checkDaemonHealth(socketPath, tokenPath)).resolves.toBe('rejected')
      await expect(healthCheckDaemon(socketPath, tokenPath)).resolves.toBe(false)
    } finally {
      await server.shutdown()
    }
  })

  it('does not unlink a live socket when the pid file does not match this daemon', async () => {
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
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toMatchObject({
        killed: false
      })
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
      startedAtMs: 1_700_000_000_000,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null
    })
  })

  it('parses JSON pid files with launch metadata', () => {
    const serialized = serializeDaemonPidFile({
      pid: 12345,
      startedAtMs: 1_700_000_000_000,
      entryPath: '/repo/out/main/daemon-entry.js',
      appVersion: '1.2.3'
    })
    expect(parseDaemonPidFile(serialized)).toEqual({
      pid: 12345,
      startedAtMs: 1_700_000_000_000,
      entryPath: '/repo/out/main/daemon-entry.js',
      appVersion: '1.2.3',
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null
    })
  })

  it('preserves exact-incarnation launch and Linux process identity', () => {
    const serialized = serializeDaemonPidFile({
      pid: 12345,
      startedAtMs: 1_700_000_000_000,
      launchNonce: 'launch-a',
      linuxStartTicks: '4242',
      bootId: 'boot-a'
    })
    expect(parseDaemonPidFile(serialized)).toMatchObject({
      launchNonce: 'launch-a',
      linuxStartTicks: '4242',
      bootId: 'boot-a'
    })
  })

  it('accepts JSON with startedAtMs missing and returns null for it', () => {
    // Why: forward-compatible with hypothetical future daemons that might write
    // pid without startedAtMs (platform where getProcessStartedAtMs returns null).
    expect(parseDaemonPidFile('{"pid":9999}')).toEqual({
      pid: 9999,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null
    })
  })

  it('falls back to bare-integer parsing for legacy pid files', () => {
    // Why: pre-Phase-0 daemons wrote the pid file as a bare integer.
    // parseDaemonPidFile must still accept those to avoid leaking a stale
    // daemon across a single upgrade boundary.
    expect(parseDaemonPidFile('12345')).toEqual({
      pid: 12345,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null
    })
    expect(parseDaemonPidFile('  12345\n')).toEqual({
      pid: 12345,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null
    })
  })

  it('returns null for malformed input', () => {
    expect(parseDaemonPidFile('not-a-number')).toBeNull()
    expect(parseDaemonPidFile('{"pid":"abc"}')).toBeNull()
    expect(parseDaemonPidFile('{"not_pid":123}')).toBeNull()
  })
})

describe('Linux process start-time parsing', () => {
  it('parses start ticks from proc stat with spaces in the command name', () => {
    const fields = Array.from({ length: 20 }, (_, index) => String(index + 1))
    fields[0] = 'S'
    fields[19] = '987654'

    expect(parseLinuxProcStartTicks(`123 (orca daemon) ${fields.join(' ')}`)).toBe(987654)
  })

  it('parses boot time seconds from proc stat output', () => {
    expect(parseLinuxBootTimeSeconds('cpu  1 2 3\r\nbtime 1700000000\nintr 1')).toBe(1_700_000_000)
  })

  it('does not use line-array or whitespace-regex splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')

    parseLinuxProcStartTicks('123 (orca daemon) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 42')
    parseLinuxBootTimeSeconds('cpu 1 2 3\nbtime 1700000000')

    const usedUnboundedSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && (separator === '\n' || separator === ' ')) ||
        (separator instanceof RegExp && separator.source.includes('\\s+'))
    )
    splitSpy.mockRestore()
    expect(usedUnboundedSplit).toBe(false)
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
    const actual = getProcessStartedAtMs(process.pid)
    if (actual === null) {
      return
    }
    // Shift expected by 10s — clearly outside the ±1500ms tolerance.
    expect(startTimeMatches(process.pid, actual + 10_000)).toBe(false)
  })
})

describe('parseWindowsProcessIdentityJson', () => {
  it('parses command line and start time from the CIM query output', () => {
    expect(
      parseWindowsProcessIdentityJson(
        '{"cmd":"Orca.exe daemon-entry.js","start":1700000000000}\r\n'
      )
    ).toEqual({ commandLine: 'Orca.exe daemon-entry.js', startedAtMs: 1_700_000_000_000 })
  })

  it('returns a null start time when CreationDate was unavailable', () => {
    expect(
      parseWindowsProcessIdentityJson('{"cmd":"Orca.exe daemon-entry.js","start":null}')
    ).toEqual({ commandLine: 'Orca.exe daemon-entry.js', startedAtMs: null })
  })

  it('returns null for a missing process or inaccessible command line', () => {
    expect(parseWindowsProcessIdentityJson('')).toBeNull()
    expect(parseWindowsProcessIdentityJson('   \r\n')).toBeNull()
    expect(parseWindowsProcessIdentityJson('{"cmd":null,"start":123}')).toBeNull()
    expect(parseWindowsProcessIdentityJson('not-json')).toBeNull()
  })
})

describe('startTimesWithinTolerance', () => {
  it('fails open when either side is null', () => {
    expect(startTimesWithinTolerance(null, 1_700_000_000_000, 1_500)).toBe(true)
    expect(startTimesWithinTolerance(1_700_000_000_000, null, 1_500)).toBe(true)
    expect(startTimesWithinTolerance(null, null, 1_500)).toBe(true)
  })

  it('matches within tolerance and rejects outside it', () => {
    expect(startTimesWithinTolerance(1_700_000_001_000, 1_700_000_000_000, 1_500)).toBe(true)
    expect(startTimesWithinTolerance(1_700_000_005_000, 1_700_000_000_000, 1_500)).toBe(false)
  })
})

describe('killStaleDaemon pid identity guards', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-pid-test-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not SIGTERM when the saved startedAtMs mismatches the current process', async () => {
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
      await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toMatchObject({
        killed: false
      })
      const terminationSignals = killSpy.mock.calls.filter(
        ([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'
      )
      expect(terminationSignals).toEqual([])
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('killStaleDaemon ownership decisions', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-kill-test-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function listenOnSocketPath(server: Server, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
  }

  it.each<{ outcome: SocketProbeOutcome; liveOwnerSurvived: boolean }>([
    { outcome: 'connected', liveOwnerSurvived: true },
    { outcome: 'refused', liveOwnerSurvived: false },
    { outcome: 'missing', liveOwnerSurvived: false },
    { outcome: 'unknown', liveOwnerSurvived: false }
  ])(
    'reports liveOwnerSurvived=$liveOwnerSurvived for a $outcome endpoint',
    async ({ outcome, liveOwnerSurvived }) => {
      const probeEndpoint = vi.fn(async () => outcome)

      await expect(
        killStaleDaemon(dir, socketPath, tokenPath, undefined, { probeEndpoint })
      ).resolves.toEqual({ killed: false, liveOwnerSurvived })
      expect(probeEndpoint).toHaveBeenCalledOnce()
      expect(probeEndpoint).toHaveBeenCalledWith(socketPath)
    }
  )

  it('preserves a daemon that cannot be proven dead', async () => {
    const record = serializeDaemonPidFile({
      pid: process.pid,
      startedAtMs: null,
      launchNonce: 'live-owner'
    })
    writeFileSync(getDaemonPidPath(dir), record, { mode: 0o600 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    try {
      await expect(
        killStaleDaemon(dir, socketPath, tokenPath, undefined, {
          probeEndpoint: async () => 'unknown'
        })
      ).resolves.toEqual({ killed: false, liveOwnerSurvived: true })
      expect(readFileSync(getDaemonPidPath(dir), 'utf8')).toBe(record)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('removes a malformed pid record', async () => {
    writeFileSync(getDaemonPidPath(dir), '{truncated', { mode: 0o600 })

    await killStaleDaemon(dir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => 'missing'
    })

    expect(existsSync(getDaemonPidPath(dir))).toBe(false)
  })

  it('removes a legacy bare-integer pid record', async () => {
    writeFileSync(getDaemonPidPath(dir), String(999_999), { mode: 0o600 })

    await killStaleDaemon(dir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => 'missing'
    })

    expect(existsSync(getDaemonPidPath(dir))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    "leaves a replacement's pid record after killing the recorded owner",
    async () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
          'daemon-entry',
          socketPath,
          tokenPath
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      // The handler must exist before SIGTERM to hold the fencing window open.
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.stdout?.once('data', () => resolve())
      })
      const childPid = child.pid as number
      const childExited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      writeFileSync(
        getDaemonPidPath(dir),
        serializeDaemonPidFile({ pid: childPid, startedAtMs: null, launchNonce: 'daemon-a' }),
        { mode: 0o600 }
      )

      const replacementRecord = serializeDaemonPidFile({
        pid: process.pid,
        startedAtMs: 2_000,
        launchNonce: 'daemon-b'
      })
      const replacement = createServer((socket) => socket.end())
      const handover = setTimeout(() => {
        void listenOnSocketPath(replacement, socketPath).then(() => {
          writeFileSync(getDaemonPidPath(dir), replacementRecord, { mode: 0o600 })
        })
      }, 300)

      try {
        await expect(killStaleDaemon(dir, socketPath, tokenPath)).resolves.toEqual({
          killed: true,
          liveOwnerSurvived: true
        })
        expect(readFileSync(getDaemonPidPath(dir), 'utf8')).toBe(replacementRecord)
        await expect(canConnect(socketPath)).resolves.toBe(true)
      } finally {
        clearTimeout(handover)
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        await childExited
        await closeServer(replacement)
      }
    }
  )
})
