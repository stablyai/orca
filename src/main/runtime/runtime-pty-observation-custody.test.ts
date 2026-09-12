import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimePtyOwnershipRevisions } from './runtime-pty-ownership-revisions'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'

function fixture() {
  const runtime = new OrcaRuntimeService(null)
  const pending: ((sessions: PtyProcessInfo[]) => void)[] = []
  const controller = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(() => new Promise<PtyProcessInfo[]>((resolve) => pending.push(resolve)))
  }
  runtime.setPtyController(controller)
  const internal = runtime as unknown as {
    ptysById: Map<string, RuntimePtyWorktreeRecord>
    ptyOwnershipRevisions: { observations: Set<unknown> }
    refreshPtyWorktreeRecordsWithControllerInventory: (
      worktrees: [],
      target?: string | null,
      deadline?: number
    ) => Promise<PtyControllerInventory | null>
  }
  const register = (incarnationId: string, id = 'synthetic-pty') =>
    runtime.registerPty(id, 'folder:synthetic', null, {
      tabId: 'tab-terminal',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId,
      agentLaunchAuthority: { launchToken: `synthetic-${incarnationId}`, launchAgent: 'codex' }
    })
  const session = (incarnationId = 'a'): PtyProcessInfo => ({
    id: 'synthetic-pty',
    worktreeId: 'folder:synthetic',
    incarnationId,
    cwd: '',
    title: 'inventory-title'
  })
  return {
    runtime,
    controller,
    register,
    session,
    start: (target?: string | null, deadline?: number) =>
      internal.refreshPtyWorktreeRecordsWithControllerInventory([], target, deadline),
    finish: (sessions: PtyProcessInfo[], index = 0) => pending[index](sessions),
    active: () => internal.ptyOwnershipRevisions.observations.size,
    record: () => internal.ptysById.get('synthetic-pty')!
  }
}

describe('inventory observation custody', () => {
  const schedules = [false, true].flatMap((absent) =>
    Array.from({ length: 11 }, (_, ticks) => ({ absent, ticks }))
  )
  it.each(schedules)(
    'preserves replacement at offset $ticks, absent=$absent',
    async ({ ticks, absent }) => {
      const f = fixture()
      f.register('a')
      const pending = f.start()
      f.finish(absent ? [] : [f.session()])
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve()
      }
      f.register('b')
      await pending
      expect(f.record()).toMatchObject({
        incarnationId: 'b',
        launchToken: 'synthetic-b',
        connected: true
      })
      expect(f.active()).toBe(0)
    }
  )

  it('releases successful and rejected censuses', async () => {
    const f = fixture()
    f.register('a')
    const success = f.start()
    expect(f.active()).toBe(1)
    f.finish([f.session()])
    expect(await success).not.toBeNull()
    expect(f.active()).toBe(0)
    const rejected = f.start()
    f.register('b')
    f.finish([], 1)
    expect(await rejected).toBeNull()
    expect(f.active()).toBe(0)
  })

  it.each(['throw', 'reject'])(
    'releases a provider %s and admits the next census',
    async (mode) => {
      const f = fixture()
      f.register('a')
      f.controller.listProcesses.mockImplementationOnce(() => {
        if (mode === 'throw') {
          throw new Error('synthetic read failure')
        }
        return Promise.reject(new Error('synthetic read failure'))
      })
      if (mode === 'throw') {
        await expect(f.start()).rejects.toThrow('synthetic read failure')
      } else {
        expect(await f.start()).toBeNull()
      }
      expect(f.active()).toBe(0)
      const next = f.start()
      f.finish([f.session()])
      expect(await next).not.toBeNull()
      expect(f.active()).toBe(0)
    }
  )

  it('releases a timeout without applying its late response', async () => {
    const f = fixture()
    f.register('a')
    expect(await f.start(null, Date.now())).toBeNull()
    expect(f.active()).toBe(0)
    f.register('b')
    f.finish([f.session()])
    const next = f.start()
    f.finish([f.session('b')], 1)
    expect(await next).not.toBeNull()
    expect(f.active()).toBe(0)
    expect(f.record().launchToken).toBe('synthetic-b')
  })

  it('releases when synchronous application throws', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    const invalid = f.session()
    Object.defineProperty(invalid, 'title', {
      get: () => {
        throw new Error('synthetic application failure')
      }
    })
    f.finish([invalid])
    await expect(pending).rejects.toThrow('synthetic application failure')
    expect(f.active()).toBe(0)
    const next = f.start()
    f.finish([f.session()], 1)
    expect(await next).not.toBeNull()
    expect(f.active()).toBe(0)
  })

  it('releases cancellation-invalidated inventory', async () => {
    const f = fixture()
    f.register('a')
    f.runtime.beginPtyRegistration('synthetic-pty', 'b')
    const pending = f.start()
    f.runtime.cancelPendingPtyRegistration('synthetic-pty', 'b')
    f.finish([])
    expect(await pending).toBeNull()
    expect(f.active()).toBe(0)
    expect(f.record().connected).toBe(true)
  })

  it('releases a stale generation and its targeted retry', async () => {
    const f = fixture()
    f.register('a')
    const first = f.start('folder:synthetic')
    const second = f.start()
    f.finish([f.session()], 1)
    expect(await second).not.toBeNull()
    f.controller.listProcesses.mockResolvedValueOnce([f.session()])
    f.finish([f.session()])
    expect(await first).not.toBeNull()
    expect(f.controller.listProcesses).toHaveBeenCalledTimes(3)
    expect(f.active()).toBe(0)
  })

  it('defers unrelated same-host rows until a census without conflicting churn', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    f.register('b', 'unrelated-pty')
    f.finish([f.session()])
    expect(await pending).toBeNull()
    expect(f.record().controllerTitle).toBeNull()
    const next = f.start()
    f.finish([f.session()], 1)
    expect(await next).not.toBeNull()
    expect(f.record().controllerTitle).toBe('inventory-title')
    expect(f.active()).toBe(0)
  })

  it('retains custody through consumer awaits and refuses escaped observations', async () => {
    const revisions = new RuntimePtyOwnershipRevisions()
    let escaped!: Parameters<typeof revisions.admits>[0]
    await revisions.withObservation(async (observation) => {
      escaped = observation
      await Promise.resolve()
      revisions.advance('new-owner')
      expect(revisions.admits(observation, [], new Map(), new Map())).toBe(false)
    })
    expect(revisions.admits(escaped, [], new Map(), new Map())).toBe(false)
    await revisions.withObservation(async (observation) => {
      expect(revisions.admits(observation, [], new Map(), new Map())).toBe(true)
    })
  })
})
