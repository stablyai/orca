import { EventEmitter } from 'node:events'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ownerIdentity from '../../../agent-hooks/managed-hook-owner-identity'
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
  it('does not start a supervisor for an unreadable index', async () => {
    const home = await createTemporaryRoot()
    await writeFile(join(home, 'state_5.sqlite'), 'not a sqlite database')
    const run = vi.fn()
    const withLock = vi.fn()

    await expect(
      startCodexStateDbBackfillRecoveryInBackground(home, {
        run,
        withLock: withLock as never
      })
    ).resolves.toBeNull()
    expect(withLock).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
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
      readStatus: vi.fn((): CodexStateDbBackfillStatus => ({
        kind: 'incomplete',
        stateDbPath: '/state.sqlite',
        status: 'running'
      })),
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
