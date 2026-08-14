import { EventEmitter } from 'node:events'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ownerIdentity from '../agent-hooks/managed-hook-owner-identity'
import {
  _internals,
  resolveCodexBackfillSupervisorLockRoot,
  runCodexStateDbBackfillRecovery,
  startCodexStateDbBackfillRecoveryInBackground,
  withCodexBackfillSupervisorLock
} from './codex-state-db-backfill-recovery'
import type { CodexStateDbBackfillStatus } from './codex-state-db'

const temporaryRoots: string[] = []
const originalPlatform = process.platform

function createFakeChild(): EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn> }
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn() },
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  })
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-backfill-recovery-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  _internals.resetForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Codex state DB backfill recovery', () => {
  it('does not restart an exhausted supervisor when later triggers arrive', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const run = vi.fn(async () => ({ outcome: 'gave-up' as const, spawnCount: 5 }))
    const withLock = vi.fn(
      async (_home: string, _signal: AbortSignal | undefined, claim: () => Promise<unknown>) =>
        await claim()
    )
    const dependencies = {
      isPending: vi.fn(() => true),
      run,
      withLock: withLock as never
    }

    const first = startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies)
    await expect(first).resolves.toEqual({ outcome: 'gave-up', spawnCount: 5 })
    const repeated = startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies)

    expect(repeated).toBe(first)
    await expect(repeated).resolves.toEqual({ outcome: 'gave-up', spawnCount: 5 })
    expect(dependencies.isPending).toHaveBeenCalledTimes(1)
    expect(withLock).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('releases a completed supervisor entry', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const run = vi.fn(async () => ({ outcome: 'completed' as const, spawnCount: 1 }))
    const dependencies = {
      isPending: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
      run,
      withLock: vi.fn(
        async (_home: string, _signal: AbortSignal | undefined, claim: () => Promise<unknown>) =>
          await claim()
      ) as never
    }

    await expect(
      startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies)
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })
    await expect(
      startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies)
    ).resolves.toBeNull()

    expect(dependencies.isPending).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('releases a failed owner-lock attempt for later arbitration', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const dependencies = {
      isPending: vi.fn(() => true),
      run: vi.fn(async () => ({ outcome: 'completed' as const, spawnCount: 1 })),
      withLock: vi
        .fn()
        .mockRejectedValueOnce(new Error('owner still live'))
        .mockImplementation(
          async (_home: string, _signal: AbortSignal | undefined, claim: () => Promise<unknown>) =>
            await claim()
        )
    }

    await expect(
      startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies as never)
    ).resolves.toBeNull()
    await expect(
      startCodexStateDbBackfillRecoveryInBackground('/managed-home', dependencies as never)
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })

    expect(dependencies.isPending).toHaveBeenCalledTimes(2)
    expect(dependencies.withLock).toHaveBeenCalledTimes(2)
    expect(dependencies.run).toHaveBeenCalledTimes(1)
  })

  it('bounds permanent coordinator failures across later triggers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dependencies = {
      isPending: vi.fn(() => true),
      run: vi.fn(),
      withLock: vi.fn(async () => {
        throw new Error('permanent lock-root failure')
      })
    }
    const tasks: Promise<unknown>[] = []

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const task = startCodexStateDbBackfillRecoveryInBackground(
        '/managed-home',
        dependencies as never
      )
      tasks.push(task)
      await expect(task).resolves.toBeNull()
    }

    expect(tasks[5]).toBe(tasks[4])
    expect(dependencies.isPending).toHaveBeenCalledTimes(5)
    expect(dependencies.withLock).toHaveBeenCalledTimes(5)
    expect(dependencies.run).not.toHaveBeenCalled()
  })

  it('bounds permanent claimant exits just beyond the fast-failure window', async () => {
    const controller = new AbortController()
    const children = new Map<ReturnType<typeof createFakeChild>, number>()
    const timerDurations: number[] = []
    let now = 0
    let exitCount = 0
    let pendingTimers = 0
    let maxPendingTimers = 0
    let maxLiveChildren = 0
    let safetyFuseTripped = false
    const terminate = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => {
      const child = createFakeChild()
      children.set(child, now + 10_001)
      maxLiveChildren = Math.max(maxLiveChildren, children.size)
      return child
    })
    const sleep = vi.fn(async (ms: number) => {
      timerDurations.push(ms)
      pendingTimers += 1
      maxPendingTimers = Math.max(maxPendingTimers, pendingTimers)
      const wakeAt = now + ms
      for (const [child, exitAt] of children) {
        if (exitAt <= wakeAt) {
          now = exitAt
          children.delete(child)
          exitCount += 1
          child.emit('exit', 1, null)
        }
      }
      now = wakeAt
      pendingTimers -= 1
      if (ms === 2_000 && spawnProcess.mock.calls.length === 6) {
        safetyFuseTripped = true
        controller.abort()
        throw Object.assign(new Error('reproduction safety fuse'), { name: 'AbortError' })
      }
      await Promise.resolve()
    })

    const summary = await runCodexStateDbBackfillRecovery('/managed-home', controller.signal, {
      spawnProcess: spawnProcess as never,
      readStatus: vi.fn(
        (): CodexStateDbBackfillStatus => ({
          kind: 'incomplete',
          stateDbPath: '/state.sqlite',
          status: 'running'
        })
      ),
      terminate,
      sleep,
      now: () => now
    })

    expect({
      summary,
      spawnCount: spawnProcess.mock.calls.length,
      exitCount,
      timerCount: timerDurations.length,
      pollCount: timerDurations.filter((ms) => ms === 5_000).length,
      backoffCount: timerDurations.filter((ms) => ms === 2_000).length,
      liveChildren: children.size,
      pendingTimers,
      maxLiveChildren,
      maxPendingTimers,
      terminateCount: terminate.mock.calls.length,
      safetyFuseTripped
    }).toEqual({
      summary: { outcome: 'gave-up', spawnCount: 5 },
      spawnCount: 5,
      exitCount: 5,
      timerCount: 19,
      pollCount: 15,
      backoffCount: 4,
      liveChildren: 0,
      pendingTimers: 0,
      maxLiveChildren: 1,
      maxPendingTimers: 1,
      terminateCount: 0,
      safetyFuseTripped: false
    })
  })

  it('recovers after claimant exits just beyond the old fast-failure window', async () => {
    const children = new Map<ReturnType<typeof createFakeChild>, number>()
    const timerDurations: number[] = []
    let now = 0
    let exitCount = 0
    let pendingTimers = 0
    let maxLiveChildren = 0
    const spawnProcess = vi.fn(() => {
      const child = createFakeChild()
      children.set(child, now + 10_001)
      maxLiveChildren = Math.max(maxLiveChildren, children.size)
      return child
    })
    const terminate = vi.fn(async (child: ReturnType<typeof createFakeChild>) => {
      children.delete(child)
    })
    const sleep = vi.fn(async (ms: number) => {
      timerDurations.push(ms)
      pendingTimers += 1
      const wakeAt = now + ms
      for (const [child, exitAt] of children) {
        if (exitAt <= wakeAt) {
          now = exitAt
          children.delete(child)
          exitCount += 1
          child.emit('exit', 1, null)
        }
      }
      now = wakeAt
      pendingTimers -= 1
      await Promise.resolve()
    })

    const summary = await runCodexStateDbBackfillRecovery(
      '/managed-home',
      new AbortController().signal,
      {
        spawnProcess: spawnProcess as never,
        readStatus: vi.fn(
          (): CodexStateDbBackfillStatus =>
            spawnProcess.mock.calls.length >= 3
              ? { kind: 'complete', stateDbPath: '/state.sqlite' }
              : {
                  kind: 'incomplete',
                  stateDbPath: '/state.sqlite',
                  status: 'running'
                }
        ),
        terminate: terminate as never,
        sleep,
        now: () => now
      }
    )

    expect({
      summary,
      spawnCount: spawnProcess.mock.calls.length,
      exitCount,
      timerCount: timerDurations.length,
      pollCount: timerDurations.filter((ms) => ms === 5_000).length,
      backoffCount: timerDurations.filter((ms) => ms === 2_000).length,
      liveChildren: children.size,
      pendingTimers,
      maxLiveChildren,
      terminateCount: terminate.mock.calls.length
    }).toEqual({
      summary: { outcome: 'completed', spawnCount: 3 },
      spawnCount: 3,
      exitCount: 2,
      timerCount: 9,
      pollCount: 7,
      backoffCount: 2,
      liveChildren: 0,
      pendingTimers: 0,
      maxLiveChildren: 1,
      terminateCount: 1
    })
  })

  it('recovers after a transient process spawn error', async () => {
    const children = [createFakeChild(), createFakeChild()]
    let spawnCount = 0
    let now = 0
    const timerDurations: number[] = []
    const spawnProcess = vi.fn(() => {
      const child = children[spawnCount++]
      if (spawnCount === 1) {
        queueMicrotask(() => child.emit('error', new Error('temporary launch failure')))
      }
      return child
    })
    const terminate = vi.fn(async () => {})

    await expect(
      runCodexStateDbBackfillRecovery('/managed-home', new AbortController().signal, {
        spawnProcess: spawnProcess as never,
        readStatus: vi.fn(
          (): CodexStateDbBackfillStatus =>
            spawnCount >= 2
              ? { kind: 'complete', stateDbPath: '/state.sqlite' }
              : { kind: 'incomplete', stateDbPath: '/state.sqlite', status: 'running' }
        ),
        terminate,
        sleep: vi.fn(async (ms: number) => {
          timerDurations.push(ms)
          now += ms
          await Promise.resolve()
        }),
        now: () => now
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 2 })
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(timerDurations).toEqual([5_000, 2_000, 5_000])
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledWith(children[1])
  })

  it('keeps the successful app-server claimant alive until Codex marks its DB complete', async () => {
    const child = createFakeChild()
    const terminate = vi.fn(async () => {})
    const readStatus = vi
      .fn()
      .mockReturnValueOnce({ kind: 'incomplete', stateDbPath: '/state.sqlite', status: 'running' })
      .mockReturnValue({ kind: 'complete', stateDbPath: '/state.sqlite' })

    await expect(
      runCodexStateDbBackfillRecovery('/managed-home', new AbortController().signal, {
        spawnProcess: vi.fn(() => child) as never,
        readStatus,
        terminate,
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 1_000)
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })
    expect(terminate).toHaveBeenCalledWith(child)
  })

  it('retries a live foreign lease until one durable claimant can recover it', async () => {
    const first = createFakeChild()
    const second = createFakeChild()
    const children = [first, second]
    let now = 0
    let spawnCount = 0
    const spawnProcess = vi.fn(() => {
      const child = children[spawnCount++]
      if (child === first) {
        queueMicrotask(() => child.emit('exit', 1, null))
      }
      return child
    })
    const readStatus = vi.fn(
      (): CodexStateDbBackfillStatus =>
        spawnCount >= 2
          ? { kind: 'complete', stateDbPath: '/state.sqlite' }
          : { kind: 'incomplete', stateDbPath: '/state.sqlite', status: 'running' }
    )

    await expect(
      runCodexStateDbBackfillRecovery('/managed-home', new AbortController().signal, {
        spawnProcess: spawnProcess as never,
        readStatus,
        terminate: vi.fn(async () => {}),
        sleep: vi.fn(async (ms: number) => {
          now += ms
          await Promise.resolve()
        }),
        now: () => now
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 2 })
  })

  it('routes a WSL managed home through its distro and Linux CODEX_HOME', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => child)
    const readStatus = vi
      .fn()
      .mockReturnValueOnce({ kind: 'incomplete', stateDbPath: 'state.sqlite', status: 'running' })
      .mockReturnValue({ kind: 'complete', stateDbPath: 'state.sqlite' })

    await runCodexStateDbBackfillRecovery(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      new AbortController().signal,
      {
        spawnProcess: spawnProcess as never,
        readStatus,
        terminate: vi.fn(async () => {}),
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 1_000)
      }
    )

    expect(spawnProcess).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu']),
      expect.objectContaining({ windowsHide: true })
    )
    const spawnCall = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    const command = spawnCall[1].join(' ')
    expect(command).toContain('export CODEX_HOME=')
    expect(command).toContain('/home/alice/.codex')
  })
})

describe.skipIf(process.platform === 'win32')('Codex backfill supervisor owner lock', () => {
  it('recovers a dead owner whose PID was reused with a different start identity', async () => {
    const userData = await createTemporaryRoot()
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    const home = join(userData, 'managed-home')
    const lockRoot = resolveCodexBackfillSupervisorLockRoot(home)
    const lockParent = join(lockRoot, '.orca')
    const token = '00000000-0000-4000-8000-000000000000'
    const ownerPath = join(lockParent, `managed-hook-install.owner-${token}.json`)
    const lockPath = join(lockParent, 'managed-hook-install.lock')
    await mkdir(lockParent, { recursive: true })
    await writeFile(
      ownerPath,
      JSON.stringify({
        token,
        pid: process.pid,
        hostIdentity: await ownerIdentity.readManagedHookHostIdentity(),
        processIdentity: 'stale-process-start-time'
      })
    )
    await link(ownerPath, lockPath)

    await expect(
      withCodexBackfillSupervisorLock(home, undefined, async () => 'recovered')
    ).resolves.toBe('recovered')
  })

  it('does not interfere with a live supervisor from another Orca instance', async () => {
    const userData = await createTemporaryRoot()
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    const home = join(userData, 'managed-home')
    let releaseFirst!: () => void
    const first = withCodexBackfillSupervisorLock(
      home,
      undefined,
      async () => await new Promise<void>((resolve) => (releaseFirst = resolve))
    )
    await vi.waitFor(async () => {
      await expect(
        import('node:fs/promises').then(({ readFile }) =>
          readFile(
            join(
              resolveCodexBackfillSupervisorLockRoot(home),
              '.orca',
              'managed-hook-install.lock'
            ),
            'utf8'
          )
        )
      ).resolves.toContain('processIdentity')
    })
    const controller = new AbortController()
    const secondRun = vi.fn(async () => {})
    setTimeout(() => controller.abort(), 40)

    await expect(
      withCodexBackfillSupervisorLock(home, controller.signal, secondRun)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(secondRun).not.toHaveBeenCalled()
    releaseFirst()
    await first
  })
})
