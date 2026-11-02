import './mock-descendant-sweep'
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
  checkDaemonHealthWithCoverage,
  E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV,
  getMacDaemonSystemResolverHealth,
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
import type { SubprocessHandle } from './session-subprocess-handle'
import type * as ResolverHealthModule from '../network/macos-system-resolver-health'
import type { SystemResolverHealth } from './types'

const readResolverHealthMock = vi.hoisted(() => vi.fn<() => Promise<SystemResolverHealth>>())

vi.mock('../network/macos-system-resolver-health', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolverHealthModule>()),
  readCurrentProcessMacSystemResolverHealth: readResolverHealthMock
}))

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
      await expect(checkDaemonHealthWithCoverage(socketPath, tokenPath)).resolves.toEqual({
        verdict: 'healthy',
        coverage: process.platform === 'win32' ? 'handshake' : 'pty-spawn'
      })
      expect(ptySpawnHealthCheck).toHaveBeenCalledTimes(3)
    } finally {
      await server.shutdown()
    }
  })

  it('treats missing coverage from a legacy Windows daemon as handshake-only', async () => {
    writeFileSync(tokenPath, 'legacy-token')
    const server = createServer((socket) => {
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk.toString()
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline === -1) {
            return
          }
          const message: unknown = JSON.parse(pending.slice(0, newline))
          const type =
            typeof message === 'object' && message !== null && 'type' in message
              ? message.type
              : undefined
          pending = pending.slice(newline + 1)
          if (type === 'hello') {
            socket.write(`${JSON.stringify({ type: 'hello', ok: true })}\n`)
          } else if (type === 'ptySpawnHealth') {
            socket.write(
              `${JSON.stringify({ id: 'health-1', ok: true, payload: { healthy: true } })}\n`
            )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await expect(checkDaemonHealthWithCoverage(socketPath, tokenPath)).resolves.toEqual({
        verdict: 'healthy',
        coverage: 'handshake'
      })
    } finally {
      Object.defineProperty(process, 'platform', platform)
      await closeServer(server)
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

  // The resolver probe answers 'unknown' off macOS without touching the socket.
  describe.skipIf(process.platform !== 'darwin')('macOS resolver health probe', () => {
    afterEach(() => {
      vi.useRealTimers()
      readResolverHealthMock.mockReset()
    })

    it('answers concurrent probes instead of evicting each other', async () => {
      // Hold every answer until all three probes are live so their control sockets overlap.
      const releaseProbes: (() => void)[] = []
      readResolverHealthMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseProbes.push(() => resolve('healthy'))
            if (releaseProbes.length === 3) {
              releaseProbes.forEach((release) => release())
            }
          })
      )
      const server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()

      try {
        const results = await Promise.all([
          getMacDaemonSystemResolverHealth(socketPath, tokenPath),
          getMacDaemonSystemResolverHealth(socketPath, tokenPath),
          getMacDaemonSystemResolverHealth(socketPath, tokenPath)
        ])
        expect(results).toEqual(['healthy', 'healthy', 'healthy'])
      } finally {
        await server.shutdown()
      }
    })

    it('settles as unknown when the daemon closes the probe socket', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      writeFileSync(tokenPath, 'token', { mode: 0o600 })
      const server = createServer((socket) => {
        socket.once('data', () => {
          socket.write(`${JSON.stringify({ type: 'hello', ok: true })}\n`)
          socket.once('data', () => socket.end())
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })

      try {
        await expect(getMacDaemonSystemResolverHealth(socketPath, tokenPath)).resolves.toBe(
          'unknown'
        )
      } finally {
        await closeServer(server)
      }
    })
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
      spawnerExecPath: null,
      cgroupUnit: null,
      processCeiling: null
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
      spawnerExecPath: null,
      cgroupUnit: null,
      processCeiling: null
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
    expect(parseDaemonPidFile('{"pid":9999}')).toEqual({
      pid: 9999,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null,
      cgroupUnit: null,
      processCeiling: null
    })
  })

  it('falls back to bare-integer parsing for legacy pid files', () => {
    // Accept bare-integer PID records across upgrades.
    expect(parseDaemonPidFile('12345')).toEqual({
      pid: 12345,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null,
      cgroupUnit: null,
      processCeiling: null
    })
    expect(parseDaemonPidFile('  12345\n')).toEqual({
      pid: 12345,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      launchNonce: null,
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: null,
      cgroupUnit: null,
      processCeiling: null
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
    expect(startTimeMatches(process.pid, null)).toBe(true)
  })

  it('returns true when actual start time cannot be read (fail-open)', () => {
    if (process.platform === 'win32') {
      expect(startTimeMatches(process.pid, 1_700_000_000_000)).toBe(true)
      return
    }
    // PID 0 has no /proc entry or ps start time, exercising the unknown-start-time fallback.
    expect(startTimeMatches(0, 1_700_000_000_000)).toBe(true)
  })

  it('returns true for matching start time within tolerance', () => {
    if (process.platform === 'win32') {
      return
    }
    const actual = getProcessStartedAtMs(process.pid)
    if (actual === null) {
      return
    }
    expect(startTimeMatches(process.pid, actual + 500)).toBe(true)
  })

  it('returns false for start times outside tolerance', () => {
    const actual = getProcessStartedAtMs(process.pid)
    if (actual === null) {
      return
    }
    expect(startTimeMatches(process.pid, actual + 10_000)).toBe(false)
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
    const bogusStartedAtMs = Date.now() - 60 * 60 * 1000
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: bogusStartedAtMs }),
      { mode: 0o600 }
    )

    // Signal 0 checks liveness; only termination signals must be absent.
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
      // Wait until the child installs its SIGTERM handler so the fencing window stays open.
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
