import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/pty-provider-contract'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { sweepProviderByPrefix } from '../runtime/worktree-pty-surface-sweeps'

const row = (id = 'shared', incarnationId = 'live'): PtyProcessInfo => ({
  id,
  incarnationId,
  cwd: '/project',
  title: 'shell'
})

function adapter(listProcesses: IPtyProvider['listProcesses']) {
  const provider = createAdapter('inventory')
  vi.mocked(provider.listProcesses).mockImplementation(listProcesses)
  return provider
}

function delayedInventory(
  delayMs: number,
  processes: () => PtyProcessInfo[]
): IPtyProvider['listProcesses'] {
  return (opts) => {
    const deadlineMs = opts?.deadlineMs
    if (deadlineMs === undefined) {
      throw new Error('Inventory fixture requires the actual RPC deadline')
    }
    return new Promise((resolve, reject) => {
      const success = setTimeout(() => {
        clearTimeout(timeout)
        resolve(processes())
      }, delayMs)
      const timeout = setTimeout(
        () => {
          clearTimeout(success)
          reject(new Error('Inventory RPC deadline exceeded'))
        },
        Math.max(0, deadlineMs - Date.now())
      )
    })
  }
}

describe('daemon inventory acquisition budget', () => {
  afterEach(() => vi.useRealTimers())

  it('refreshes cleanup after a timed-out restore and stops an externally created PTY', async () => {
    vi.useFakeTimers()
    const worktreeId = 'repo::/project'
    const targetId = `${worktreeId}@@external`
    let rows: PtyProcessInfo[] = []
    const fast = adapter(async () => [...rows])
    const slow = adapter(
      vi
        .fn<IPtyProvider['listProcesses']>()
        .mockImplementationOnce(delayedInventory(3_000, () => []))
        .mockResolvedValue([])
    )
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const restore = resolver.resolve('missing-restore-pane')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(restore).resolves.toEqual({ kind: 'unknown' })
    rows = [row(targetId)]
    const facade = adapter((opts) => resolver.listProcesses(opts))
    vi.mocked(facade.shutdown).mockImplementation(async (id) => {
      rows = rows.filter((process) => process.id !== id)
    })

    const sweep = sweepProviderByPrefix(
      worktreeId,
      facade,
      Date.now() + 10_000,
      async (_id, stop) => {
        const stopped = await stop()
        return { stopped, owner: stopped }
      },
      undefined,
      true
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(sweep).resolves.toBe(1)
    expect(facade.shutdown).toHaveBeenCalledExactlyOnceWith(targetId, expect.anything())
    expect(rows).toEqual([])
    expect(fast.listProcesses).toHaveBeenCalledTimes(2)
    expect(slow.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('never supersedes a pending inventory for later strict or diagnostic deadlines', async () => {
    vi.useFakeTimers()
    const owner = adapter(delayedInventory(1_000, () => [row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const startedAt = Date.now()
    const first = resolver.listProcesses({ includeUnrouted: true })
    const readers = Array.from({ length: 20 }, (_, index) =>
      resolver.listProcesses({
        includeUnrouted: index % 2 === 0,
        ptyIds: ['shared'],
        deadlineMs: Date.now() + 31_000 + index * 1_000
      })
    )
    expect(owner.listProcesses).toHaveBeenCalledExactlyOnceWith({ deadlineMs: startedAt + 2_000 })
    await vi.advanceTimersByTimeAsync(1_000)

    for (const processes of await Promise.all([first, ...readers])) {
      expect(processes.map((process) => process.id)).toEqual(['shared'])
    }
    expect(owner.listProcesses).toHaveBeenCalledOnce()
  })

  it('caps a long diagnostic RPC at the existing resolution budget', async () => {
    vi.useFakeTimers()
    const owner = adapter(delayedInventory(3_000, () => [row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const startedAt = Date.now()
    const diagnostic = expect(
      resolver.listProcesses({ deadlineMs: startedAt + 10_000 })
    ).rejects.toThrow('Inventory RPC deadline exceeded')
    const settled = vi.fn()
    void diagnostic.then(settled)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled).toHaveBeenCalledOnce()
    await diagnostic
    expect(owner.listProcesses).toHaveBeenCalledExactlyOnceWith({ deadlineMs: startedAt + 2_000 })
  })

  it('indexes a shared incomplete observation once across one hundred resolutions', async () => {
    vi.useFakeTimers()
    let idReads = 0
    const rows = Array.from({ length: 4_096 }, (_, index) => ({
      get id() {
        idReads += 1
        return `session-${index}`
      },
      cwd: '',
      title: 'shell'
    }))
    const fast = adapter(async () => rows)
    const slow = adapter(delayedInventory(3_000, () => []))
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const resolutions = Promise.all(
      Array.from({ length: 100 }, (_, index) => resolver.resolve(`missing-${index}`))
    )
    await vi.advanceTimersByTimeAsync(2_000)

    expect((await resolutions).every((result) => result.kind === 'unknown')).toBe(true)
    expect(idReads).toBe(8_192)
    expect(fast.listProcesses).toHaveBeenCalledOnce()
    expect(slow.listProcesses).toHaveBeenCalledOnce()
  })

  it('recovers a current identity while an unrelated legacy inventory remains pending', async () => {
    vi.useFakeTimers()
    const current = adapter(
      vi
        .fn<IPtyProvider['listProcesses']>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([row('shared', 'new')])
    )
    const legacy = adapter(delayedInventory(60_000, () => []))
    const routes = new Map<string, IPtyProvider>()
    const resolver = new DaemonSessionOwnerResolver([current, legacy], routes)
    const diagnostic = expect(
      resolver.listProcesses({ includeUnrouted: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    await vi.advanceTimersByTimeAsync(100)
    resolver.invalidateProvider(current)
    const recovery = resolver.resolve('shared', 'new', true)
    expect(current.listProcesses).toHaveBeenCalledTimes(2)
    expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(recovery).resolves.toEqual({ kind: 'owner', provider: current })
    expect(routes.get('shared')).toBe(current)
    await vi.advanceTimersByTimeAsync(30_000)
    await diagnostic
  })

  it('reattaches an exact persisted incarnation despite a deadline-limited legacy provider', async () => {
    vi.useFakeTimers()
    const current = adapter(async () => [row()])
    vi.mocked(current.spawn).mockResolvedValue({
      id: 'shared',
      incarnationId: 'live',
      isReattach: true
    })
    const legacy = adapter(delayedInventory(60_000, () => []))
    const resolver = new DaemonSessionOwnerResolver([current, legacy], new Map())
    const restore = resolver.spawnAttachOnly({
      sessionId: 'shared',
      expectedIncarnationId: 'live',
      expectedIncarnationIsAuthoritative: true,
      attachOnly: true,
      cols: 80,
      rows: 24
    })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(restore).resolves.toEqual({
      id: 'shared',
      incarnationId: 'live',
      isReattach: true
    })
    expect(current.spawn).toHaveBeenCalledOnce()
    expect(legacy.spawn).not.toHaveBeenCalled()
    expect(current.listProcesses).toHaveBeenCalledOnce()
    expect(legacy.listProcesses).toHaveBeenCalledOnce()
  })
})
