import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import type { DescendantSnapshot } from '../../pty-descendant-termination'
import {
  runWorkerWatchdog,
  workerProcessGroupTarget,
  writeWorkerWatchdogSentinelAtomically
} from './worker-watchdog-entry'
import {
  parseWorkerWatchdogRequest,
  WORKER_WATCHDOG_CLEANUP_GRACE_MS,
  type WorkerWatchdogRequest,
  type WorkerWatchdogSentinel
} from './worker-watchdog-protocol'
import { launchWatchedWorker, resolveWorkerWatchdogEntryPath } from './worker-watchdog'

class FakeChild extends EventEmitter {
  pid = 4242
  kill = vi.fn(() => true)
}

function request(deadlineAt = '2026-08-15T00:00:01.000Z'): WorkerWatchdogRequest {
  return {
    dispatchId: 'ctx_watchdog',
    command: '/usr/bin/true',
    args: [],
    cwd: '/tmp',
    env: { PATH: '/usr/bin' },
    deadlineAt,
    cleanupGraceMs: WORKER_WATCHDOG_CLEANUP_GRACE_MS,
    sentinelPath: '/tmp/ctx_watchdog.json'
  }
}

function spawnFake(child: FakeChild) {
  return vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn
}

afterEach(() => {
  vi.useRealTimers()
})

describe('worker watchdog protocol', () => {
  it('fails closed on malformed or widened requests', () => {
    expect(() => parseWorkerWatchdogRequest({})).toThrow('malformed')
    expect(() =>
      parseWorkerWatchdogRequest({
        ...request(),
        cleanupGraceMs: 1
      })
    ).toThrow('malformed')
    expect(() =>
      parseWorkerWatchdogRequest({
        ...request(),
        env: { PATH: 1 }
      })
    ).toThrow('malformed')
  })

  it('uses a negative POSIX process-group target and exact Windows PID', () => {
    expect(workerProcessGroupTarget(4242, 'darwin')).toBe(-4242)
    expect(workerProcessGroupTarget(4242, 'linux')).toBe(-4242)
    expect(workerProcessGroupTarget(4242, 'win32')).toBe(4242)
  })

  it('writes sentinels through a sibling temporary file and atomic rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-watchdog-sentinel-'))
    try {
      const path = join(root, 'ctx.json')
      const sentinel: WorkerWatchdogSentinel = {
        dispatchId: 'ctx_watchdog',
        startedAt: '2026-08-15T00:00:00.000Z',
        deadlineAt: '2026-08-15T00:00:01.000Z',
        finishedAt: '2026-08-15T00:00:02.000Z',
        exitCode: 0,
        signal: null,
        stop: 'natural'
      }
      writeWorkerWatchdogSentinelAtomically(path, sentinel)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(sentinel)
      expect(readdirSync(root)).toEqual(['ctx.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('worker watchdog process ownership', () => {
  it('records natural provider exit without signalling the process group', async () => {
    const child = new FakeChild()
    const killImpl = vi.fn()
    const writeSentinel = vi.fn()
    const started = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      now: vi
        .fn()
        .mockReturnValueOnce(Date.parse('2026-08-15T00:00:00.000Z'))
        .mockReturnValue(Date.parse('2026-08-15T00:00:00.500Z')),
      killImpl,
      writeSentinelImpl: writeSentinel,
      onStarted: started
    })
    child.emit('close', 0, null)

    await expect(pending).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
      stop: 'natural'
    })
    expect(killImpl).not.toHaveBeenCalled()
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPid: 4242,
        processGroupId: 4242
      })
    )
    expect(writeSentinel).toHaveBeenCalledOnce()
  })

  it('sends TERM to the verified group, then KILL after the fixed grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      killImpl,
      writeSentinelImpl: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(killImpl).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(WORKER_WATCHDOG_CLEANUP_GRACE_MS)
    expect(killImpl).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')

    await expect(pending).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      stop: 'kill'
    })
  })

  it('records TERM when the group exits during cleanup grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'linux',
      spawnImpl: spawnFake(child),
      killImpl,
      writeSentinelImpl: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)
    child.emit('close', null, 'SIGTERM')

    await expect(pending).resolves.toMatchObject({ signal: 'SIGTERM', stop: 'term' })
    await vi.advanceTimersByTimeAsync(WORKER_WATCHDOG_CLEANUP_GRACE_MS)
    expect(killImpl).toHaveBeenCalledOnce()
  })

  it('targets the Windows tree helper instead of an unverified direct signal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const terminateWindowsTree = vi.fn(async () => {})
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'win32',
      spawnImpl: spawnFake(child),
      killImpl,
      terminateWindowsTreeImpl: terminateWindowsTree,
      writeSentinelImpl: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(terminateWindowsTree).toHaveBeenCalledWith(4242)
    expect(killImpl).not.toHaveBeenCalled()
    child.emit('close', 1, null)
    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill' })
  })

  it('records host shutdown separately from deadline exhaustion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const signals = new EventEmitter()
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request('2026-08-15T01:00:00.000Z'), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      killImpl,
      signalSource: signals
    })

    signals.emit('SIGTERM')
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await expect(pending).resolves.toMatchObject({ stop: 'shutdown' })
  })

  it('treats PTY SIGHUP teardown as an orderly shutdown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const signals = new EventEmitter()
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request('2026-08-15T01:00:00.000Z'), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      killImpl,
      signalSource: signals
    })

    signals.emit('SIGHUP')
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await expect(pending).resolves.toMatchObject({ stop: 'shutdown' })
  })

  it('fails closed when a Windows provider PID is no longer owned', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const terminateWindowsTree = vi.fn(async () => {})
    const pending = runWorkerWatchdog(request(), {
      platform: 'win32',
      spawnImpl: spawnFake(child),
      terminateWindowsTreeImpl: terminateWindowsTree,
      verifyWindowsTreeKillTargetImpl: vi.fn(async () => 'foreign' as const),
      writeSentinelImpl: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    child.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill_unknown' })
  })

  it('fails closed on a same-second detached descendant identity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.500Z')
    const child = new FakeChild()
    const pending = runWorkerWatchdog(request('2026-08-15T01:00:00.000Z'), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      captureDescendantsImpl: vi.fn(async () => ({
        rootPgid: 4242,
        capturedAtMs: Date.now(),
        descendants: [
          {
            pid: 4343,
            ppid: 4242,
            pgid: 4343,
            startedAt: 'Sat Aug 15 00:00:00 2026'
          }
        ]
      })),
      signalLiveDescendantsImpl: vi.fn(async () => 0),
      writeSentinelImpl: vi.fn()
    })
    await Promise.resolve()

    child.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill_unknown' })
  })

  it('fails closed when a natural exit has no authoritative final descendant snapshot', async () => {
    const child = new FakeChild()
    const pending = runWorkerWatchdog(request('2026-08-15T01:00:00.000Z'), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      captureDescendantsImpl: vi.fn(async () => ({
        rootPgid: 4242,
        capturedAtMs: Date.now(),
        descendants: []
      })),
      writeSentinelImpl: vi.fn()
    })
    await Promise.resolve()

    child.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill_unknown' })
  })

  it('does not leave a competing deadline cleanup armed while natural close waits for a poll', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    let resolvePoll!: (snapshot: DescendantSnapshot) => void
    const pendingPoll = new Promise<DescendantSnapshot>((resolve) => {
      resolvePoll = resolve
    })
    const captureDescendants = vi.fn().mockReturnValueOnce(pendingPoll).mockResolvedValue({
      rootPgid: null,
      capturedAtMs: Date.now(),
      descendants: []
    })
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      captureDescendantsImpl: captureDescendants,
      terminateDescendantsImpl: vi.fn(),
      forceTerminateDescendantsImpl: vi.fn(async () => 0),
      killImpl,
      writeSentinelImpl: vi.fn()
    })

    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1_000)
    resolvePoll({ rootPgid: 4242, capturedAtMs: Date.now(), descendants: [] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(WORKER_WATCHDOG_CLEANUP_GRACE_MS)

    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill_unknown' })
    expect(killImpl).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
  })

  it('hands cleanup to the deadline while natural close waits for descendant signalling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-15T00:00:00.000Z')
    const child = new FakeChild()
    const snapshot: DescendantSnapshot = {
      rootPgid: 4242,
      capturedAtMs: Date.now(),
      descendants: [
        {
          pid: 4343,
          ppid: 4242,
          pgid: 4343,
          startedAt: 'Fri Aug 14 23:59:59 2026'
        }
      ]
    }
    let resolveSignal!: (count: number) => void
    const pendingSignal = new Promise<number>((resolve) => {
      resolveSignal = resolve
    })
    const signalLiveDescendants = vi.fn(() => pendingSignal)
    const killImpl = vi.fn()
    const pending = runWorkerWatchdog(request(), {
      platform: 'darwin',
      spawnImpl: spawnFake(child),
      captureDescendantsImpl: vi.fn(async () => snapshot),
      terminateDescendantsImpl: vi.fn(),
      forceTerminateDescendantsImpl: vi.fn(async () => 0),
      signalLiveDescendantsImpl: signalLiveDescendants,
      killImpl,
      writeSentinelImpl: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)

    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(signalLiveDescendants).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    resolveSignal(1)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(WORKER_WATCHDOG_CLEANUP_GRACE_MS)

    await expect(pending).resolves.toMatchObject({ stop: 'tree_kill_unknown' })
    expect(killImpl).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
  })
})

describe('worker watchdog entry resolution', () => {
  it('uses the unpacked stable packaged path', () => {
    expect(
      resolveWorkerWatchdogEntryPath({
        isPackaged: true,
        resourcesPath: '/Applications/Orca.app/Contents/Resources'
      })
    ).toBe(
      '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/main/worker-watchdog-entry.js'
    )
  })

  const builtEntry = join(process.cwd(), 'out', 'main', 'worker-watchdog-entry.js')
  const builtIntegration = existsSync(builtEntry) ? it : it.skip

  builtIntegration(
    'terminates a real detached provider at deadline and writes authoritative evidence',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-worker-watchdog-integration-'))
      try {
        const sentinelPath = join(root, 'ctx_integration.json')
        const deadlineAt = new Date(Date.now() + 750).toISOString()
        const receipt = await launchWatchedWorker(
          {
            dispatchId: 'ctx_watchdog_integration',
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cwd: root,
            env: { PATH: process.env.PATH ?? '' },
            deadlineAt,
            cleanupGraceMs: WORKER_WATCHDOG_CLEANUP_GRACE_MS,
            sentinelPath
          },
          { entryPath: builtEntry, execPath: process.execPath }
        )
        expect(receipt).toMatchObject({
          dispatchId: 'ctx_watchdog_integration',
          sentinelPath
        })
        await vi.waitFor(
          () => {
            expect(existsSync(sentinelPath)).toBe(true)
          },
          { timeout: 12_000, interval: 50 }
        )
        expect(JSON.parse(readFileSync(sentinelPath, 'utf8'))).toMatchObject({
          dispatchId: 'ctx_watchdog_integration',
          deadlineAt,
          stop: 'term',
          signal: 'SIGTERM'
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    15_000
  )

  const posixBuiltIntegration = process.platform === 'win32' ? it.skip : builtIntegration
  posixBuiltIntegration(
    'sweeps a detached descendant outside the provider process group',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-worker-watchdog-descendant-'))
      const sentinelPath = join(root, 'ctx_descendant.json')
      const childPidPath = join(root, 'child.pid')
      let childPid: number | undefined
      try {
        const providerScript = [
          "const { spawn } = require('node:child_process')",
          "const { writeFileSync } = require('node:fs')",
          `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })`,
          'child.unref()',
          `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))`,
          'setInterval(() => {}, 1000)'
        ].join(';')
        const deadlineAt = new Date(Date.now() + 2_500).toISOString()
        await launchWatchedWorker(
          {
            dispatchId: 'ctx_watchdog_descendant',
            command: process.execPath,
            args: ['-e', providerScript],
            cwd: root,
            env: { PATH: process.env.PATH ?? '' },
            deadlineAt,
            cleanupGraceMs: WORKER_WATCHDOG_CLEANUP_GRACE_MS,
            sentinelPath
          },
          { entryPath: builtEntry, execPath: process.execPath }
        )
        await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true), {
          timeout: 2_000,
          interval: 25
        })
        childPid = Number(readFileSync(childPidPath, 'utf8'))
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true)
        await vi.waitFor(() => expect(existsSync(sentinelPath)).toBe(true), {
          timeout: 14_000,
          interval: 50
        })
        await vi.waitFor(
          () => {
            expect(() => process.kill(childPid as number, 0)).toThrow()
          },
          { timeout: 5_000, interval: 50 }
        )
      } finally {
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {
            // The watchdog already swept the detached descendant.
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
    18_000
  )

  posixBuiltIntegration(
    'sweeps a detached descendant when the provider exits naturally',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-worker-watchdog-natural-descendant-'))
      const sentinelPath = join(root, 'ctx_natural_descendant.json')
      const childPidPath = join(root, 'child.pid')
      let childPid: number | undefined
      try {
        const providerScript = [
          "const { spawn } = require('node:child_process')",
          "const { writeFileSync } = require('node:fs')",
          `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })`,
          'child.unref()',
          `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))`,
          'setTimeout(() => process.exit(0), 1500)'
        ].join(';')
        const deadlineAt = new Date(Date.now() + 30_000).toISOString()
        await launchWatchedWorker(
          {
            dispatchId: 'ctx_watchdog_natural_descendant',
            command: process.execPath,
            args: ['-e', providerScript],
            cwd: root,
            env: { PATH: process.env.PATH ?? '' },
            deadlineAt,
            cleanupGraceMs: WORKER_WATCHDOG_CLEANUP_GRACE_MS,
            sentinelPath
          },
          { entryPath: builtEntry, execPath: process.execPath }
        )
        await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true), {
          timeout: 2_000,
          interval: 25
        })
        childPid = Number(readFileSync(childPidPath, 'utf8'))
        const detachedChildPid = childPid
        await vi.waitFor(() => expect(existsSync(sentinelPath)).toBe(true), {
          timeout: 6_000,
          interval: 50
        })
        expect(JSON.parse(readFileSync(sentinelPath, 'utf8'))).toMatchObject({
          dispatchId: 'ctx_watchdog_natural_descendant',
          stop: 'tree_kill_unknown'
        })
        await vi.waitFor(() => expect(() => process.kill(detachedChildPid, 0)).toThrow(), {
          timeout: 5_000,
          interval: 50
        })
      } finally {
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {
            // The watchdog already swept the detached descendant.
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
    10_000
  )
})
