import type { FilesystemHostSupervisorOptions } from './filesystem-host-supervisor-options'
import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { expect, it, vi } from 'vitest'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostBackgroundQueue } from './filesystem-host-background-queue'

it('expires queued foreground work before launch rather than granting a fresh execution budget', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const invoke = vi.fn(async (operation) => {
    await gate
    return { kind: 'canonicalize-path' as const, canonicalPath: operation.path }
  })
  const supervisor = new FilesystemHostSupervisor({
    entryPath: 'unused',
    startProcess: async (options) => ({
      invoke,
      retire: async () => {
        options.onPhysicalExit?.()
        return true
      }
    })
  })
  const dispatch = (operationId: string, deadlineMs: number) =>
    supervisor.dispatch({
      operationId,
      operation: { kind: 'canonicalize-path', path: '/repo' },
      executionHost: 'native',
      admission: 'foreground',
      storageClass: 'workspace',
      deadlineMs
    })
  const running = dispatch('running', 1000)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
  await expect(dispatch('queued', 10)).rejects.toMatchObject({ code: 'deadline' })
  release()
  await running
  expect(invoke).toHaveBeenCalledOnce()
  await supervisor.dispose()
})
it.each([false, true])(
  'bounds background admission across independent domains (%s)',
  async (independent) => {
    const queue = new FilesystemHostBackgroundQueue(1)
    let release!: () => void
    const running = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = Array.from({ length: 128 }, (_, index) =>
      queue.run(async () => {}, null, Infinity, independent ? String(index) : '').catch(() => {})
    )
    await expect(queue.run(async () => {})).rejects.toThrow('queue is full')
    queue.dispose()
    release()
    await Promise.all([running, ...pending])
  }
)

it('expires public background calls in admission without dispatching expired work', async () => {
  vi.useFakeTimers()
  const dispatch = vi.fn<FilesystemHostSupervisor['dispatch']>(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    return { kind: 'read-snapshot-file', contentsBase64: '' }
  })
  const authority = new FilesystemHostReadAuthority({
    entryPath: 'unused',
    supervisor: {
      dispatch,
      publishFailureDomain: vi.fn(),
      removeFailureDomain: vi.fn(),
      dispose: async () => {}
    }
  })
  try {
    const blockers = Array.from({ length: 4 }, (_, i) =>
      authority.readSnapshotFile(`/home/block-${i}`, 'grok-auth')
    )
    const queued = [
      authority.readSnapshotFile('/home/queued', 'grok-auth'),
      authority.prepareRateLimitPtyCwd('/user-data/pty'),
      authority.resolveCliCommand('codex'),
      authority.readOrcaYaml('/worktree/orca.yaml'),
      authority.writeRateLimitCredential(
        '/home/.gemini/oauth_creds.json',
        'gemini-oauth-credentials',
        '{}'
      )
    ].map((task) => task.catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(5_000)
    for (const result of await Promise.all(queued.slice(0, 4))) {
      expect(result).toMatchObject({ code: 'ETIMEDOUT', reason: 'deadline' })
    }
    expect(dispatch).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await queued[4]).toMatchObject({ code: 'ETIMEDOUT', reason: 'deadline' })
    await Promise.all(blockers)
    expect(dispatch).toHaveBeenCalledTimes(4)
  } finally {
    await authority.dispose()
    vi.useRealTimers()
  }
})

it('shares the YAML budget between classification, admission and the final read', async () => {
  vi.useFakeTimers()
  const dispatch = vi.fn<FilesystemHostSupervisor['dispatch']>(async (input) => {
    if (input.operation.kind === 'classify-path') {
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      return { kind: 'classify-path', deviceId: 'device' }
    }
    await new Promise((resolve) => setTimeout(resolve, input.deadlineMs))
    throw new FilesystemHostSupervisorError('deadline', 'execution expired')
  })
  const authority = new FilesystemHostReadAuthority({
    entryPath: 'unused',
    supervisor: {
      dispatch,
      publishFailureDomain: vi.fn(),
      removeFailureDomain: vi.fn(),
      dispose: async () => {}
    }
  })
  try {
    const reading = authority.readOrcaYaml('/worktree/orca.yaml').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      deadlineMs: 1_000,
      operation: { kind: 'read-orca-yaml' }
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await reading).toMatchObject({ code: 'ETIMEDOUT' })
  } finally {
    await authority.dispose()
    vi.useRealTimers()
  }
})

it.each(['reclamation', 'retirement'] as const)(
  'does not launch expired capacity waiters or open their healthy breaker after %s',
  async (waitKind) => {
    vi.useFakeTimers()
    let releaseRetirement!: () => void
    const retirement = new Promise<void>((resolve) => {
      releaseRetirement = resolve
    })
    let releaseBusy!: () => void
    const busy = new Promise<void>((resolve) => {
      releaseBusy = resolve
    })
    const startProcess = vi.fn<NonNullable<FilesystemHostSupervisorOptions['startProcess']>>(
      async (options) => {
        const index = startProcess.mock.calls.length
        return {
          invoke: async (operation) => {
            if (index === 2 && waitKind === 'retirement') {
              await busy
            }
            return { kind: 'canonicalize-path', canonicalPath: operation.path }
          },
          retire: async () => {
            if (index === 1) {
              await retirement
            }
            options.onPhysicalExit?.()
            return true
          }
        }
      }
    )
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    for (const mount of ['a', 'b', 'c', 'd']) {
      supervisor.publishFailureDomain({
        executionHost: 'native',
        prefix: `/${mount}`,
        mountId: mount
      })
    }
    const dispatch = (mount: string, deadlineMs = 1000) =>
      supervisor.dispatch({
        operationId: mount,
        operation: { kind: 'canonicalize-path', path: `/${mount}/file` },
        executionHost: 'native',
        storageClass: 'workspace',
        admission: 'foreground',
        deadlineMs
      })
    try {
      await dispatch('a')
      const second = dispatch('b')
      await vi.advanceTimersByTimeAsync(0)
      if (waitKind === 'reclamation') {
        await second
      }
      const reclaiming = dispatch('c', waitKind === 'reclamation' ? 10 : 1000).catch(
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(0)
      const expired =
        waitKind === 'reclamation' ? reclaiming : dispatch('d', 10).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(10)
      expect(await expired).toMatchObject({ code: 'deadline' })
      expect(startProcess).toHaveBeenCalledTimes(2)
      releaseRetirement()
      releaseBusy()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.all([reclaiming, second])
      const mount = waitKind === 'reclamation' ? 'c' : 'd'
      expect(startProcess).toHaveBeenCalledTimes(waitKind === 'reclamation' ? 2 : 3)
      expect(supervisor.health().breakers[`native:${mount}`]).toBe('closed')
      await expect(dispatch(mount)).resolves.toMatchObject({ canonicalPath: `/${mount}/file` })
    } finally {
      releaseRetirement()
      releaseBusy()
      await supervisor.dispose()
      vi.useRealTimers()
    }
  }
)
