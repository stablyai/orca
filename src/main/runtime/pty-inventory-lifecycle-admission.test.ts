import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import {
  createInventoryRuntime,
  deferred,
  processRow,
  PREDECESSOR,
  PTY,
  SUCCESSOR,
  WORKTREE
} from './pty-inventory-lifecycle-fixture'

afterEach(() => vi.restoreAllMocks())

describe('inventory admission after a PTY lifecycle change', () => {
  it.each(['exit', 'registered-successor', 'spawned-successor', 'unknown-start-spawn'] as const)(
    'rejects a captured predecessor row after %s before it can adopt handles',
    async (mode) => {
      const reply = deferred<PtyProcessInfo[]>()
      const { runtime, hasPty } = createInventoryRuntime(() => reply.promise)
      if (mode !== 'unknown-start-spawn') {
        runtime.register()
      }
      const pending = runtime.read()
      if (mode !== 'unknown-start-spawn') {
        runtime.onPtyExit(PTY, 0, PREDECESSOR, { providerExitObserved: true })
      }
      if (mode === 'registered-successor') {
        runtime.register(SUCCESSOR)
      }
      if (mode === 'spawned-successor' || mode === 'unknown-start-spawn') {
        runtime.onPtySpawned(PTY, SUCCESSOR)
      }
      const current = runtime.capture()
      reply.resolve([processRow()])
      expect(await pending).toBeNull()
      expect(runtime.capture()).toEqual(current)
      expect(hasPty).not.toHaveBeenCalled()
    }
  )

  it.each(['spawn', 'register'] as const)(
    'does not apply stale absence to unknown-at-start %s',
    async (kind) => {
      const reply = deferred<PtyProcessInfo[]>()
      const { runtime, hasPty } = createInventoryRuntime(() => reply.promise)
      const pending = runtime.read()
      if (kind === 'spawn') {
        runtime.onPtySpawned(PTY, SUCCESSOR)
      } else {
        runtime.register(SUCCESSOR)
      }
      reply.resolve([])
      expect(await pending).toBeNull()
      expect(runtime.capture()).toMatchObject({ connected: true, incarnationId: SUCCESSOR })
      expect(hasPty).not.toHaveBeenCalled()
    }
  )

  it('fences a same-ID legacy registration with no incarnation', async () => {
    const reply = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime(() => reply.promise)
    runtime.registerPty(PTY, WORKTREE)
    const pending = runtime.read()
    runtime.onPtyExit(PTY, 0, undefined, { providerExitObserved: true })
    runtime.registerPty(PTY, WORKTREE)
    reply.resolve([{ id: PTY, cwd: '', title: 'stale legacy title', worktreeId: WORKTREE }])
    expect(await pending).toBeNull()
    expect(runtime.capture()).toMatchObject({
      connected: true,
      incarnationId: null,
      controllerTitle: null
    })
  })

  it('does not let an ignored predecessor exit invalidate a current inventory', async () => {
    const reply = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime(() => reply.promise)
    runtime.register(SUCCESSOR)
    const pending = runtime.read(null)
    runtime.onPtyExit(PTY, 0, PREDECESSOR, { providerExitObserved: true })
    reply.resolve([processRow(PTY, SUCCESSOR)])
    expect((await pending)?.allLivePtyIds).toEqual(new Set([PTY]))
    expect(runtime.capture().incarnationId).toBe(SUCCESSOR)
  })

  it('accepts a genuinely new row and a replacement first observed by fresh inventory', async () => {
    let sessions = [processRow()]
    const { runtime } = createInventoryRuntime(async () => sessions)
    expect((await runtime.read())?.allLivePtyIds).toEqual(new Set([PTY]))
    expect(runtime.capture().incarnationId).toBe(PREDECESSOR)
    sessions = [processRow(PTY, SUCCESSOR)]
    expect((await runtime.read())?.allLivePtyIds).toEqual(new Set([PTY]))
    expect(runtime.capture()).toMatchObject({
      incarnationId: SUCCESSOR,
      handle: `term_${SUCCESSOR}`,
      connected: true
    })
  })
})
