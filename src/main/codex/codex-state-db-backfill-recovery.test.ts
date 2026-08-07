import { EventEmitter } from 'node:events'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ownerIdentity from '../agent-hooks/managed-hook-owner-identity'
import {
  resolveCodexBackfillSupervisorLockRoot,
  runCodexStateDbBackfillRecovery,
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
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Codex state DB backfill recovery', () => {
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
