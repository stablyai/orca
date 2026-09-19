import { beforeEach, expect, it, vi } from 'vitest'
import { fixture, TAB, LEAF } from './renderer-store-fixture'
import { registerSessionHandlers } from '../../../src/main/ipc/session'
import { sessionApi } from '../../../src/preload/api/session-bridge'
import { Store } from '../../../src/main/persistence/loading-store/store'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { buildWorkspaceSessionPayload } from '../../../src/renderer/src/lib/workspace-session'
import {
  clearPaneSpawnReservation,
  makePaneSpawnReservationKey,
  reservePaneSpawn
} from '../../../src/main/ipc/pty/pane/spawn-reservation'

const wire = vi.hoisted(() => {
  const requests: Promise<unknown>[] = []
  return {
    handlers: new Map<string, (event: object, args: unknown) => unknown>(),
    requests,
    gate: Promise.resolve(),
    unavailable: false
  }
})
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: object, args: unknown) => unknown) =>
      wire.handlers.set(name, handler),
    on: () => {}
  },
  ipcRenderer: {
    invoke: (name: string, args: unknown) => {
      const pending = wire.gate.then(() => {
        if (wire.unavailable) {
          throw new Error('host-unavailable')
        }
        const handler = wire.handlers.get(name)
        if (!handler) {
          throw new Error('handler-unavailable')
        }
        return handler({}, args)
      })
      wire.requests.push(pending)
      return pending
    }
  }
}))
beforeEach(() => {
  wire.handlers.clear()
  wire.requests = []
  wire.gate = Promise.resolve()
  wire.unavailable = false
})
function connected(kind: 'repo' | 'folder' = 'repo', persist = true) {
  const f = fixture(kind, 'local', persist)
  const runtime = new OrcaRuntimeService(f.main)
  registerSessionHandlers(f.main, runtime)
  Object.assign(window.api, { session: { ...sessionApi } })
  return { ...f, runtime, drain: () => Promise.allSettled(wire.requests) }
}

for (const kind of ['repo', 'folder'] as const) {
  it(`direct empty ${kind} close survives save and restart`, async () => {
    const f = connected(kind)
    f.close()
    await f.drain()
    f.save()
    f.main.flushOrThrow()
    const restarted = new Store({ dataFile: f.file })
    expect(restarted.getWorkspaceSession().tabsByWorktree[f.worktree]).toHaveLength(0)
    restarted.flush()
    expect(f.api.pty.kill).not.toHaveBeenCalled()
  })
}

for (const change of [
  'pin',
  'new-created-at',
  'same-clock-bound-hint',
  'runtime-owner',
  'pending-spawn'
] as const) {
  it(`queued close preserves ${change}`, async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const f = connected()
    let release!: () => void
    wire.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.close()
    const key = makePaneSpawnReservationKey(f.worktree, null, `${TAB}:${LEAF}`)
    if (!key) {
      throw new Error('No reservation key')
    }
    const reservation = change === 'pending-spawn' ? reservePaneSpawn(key) : undefined
    if (change === 'pin') {
      f.rows((row) => ({ ...row, isPinned: true }))
    }
    if (change === 'new-created-at') {
      f.rows((row) => ({ ...row, createdAt: row.createdAt + 1 }))
    }
    if (change === 'runtime-owner' || change === 'same-clock-bound-hint') {
      f.runtime.registerPty('replacement', f.worktree, null, { tabId: TAB, leafId: LEAF })
    }
    if (change === 'same-clock-bound-hint') {
      f.main.persistPtyBinding({
        worktreeId: f.worktree,
        tabId: TAB,
        leafId: LEAF,
        ptyId: 'replacement'
      })
      const replacement = f.renderer.getState().createTab(f.worktree, undefined, undefined, {
        id: TAB,
        initialPtyId: 'replacement',
        activate: false
      })
      expect(replacement.createdAt).toBe(1000)
      expect(replacement.id).toBe(TAB)
      expect(f.renderer.getState().terminalLayoutsByTabId[TAB].root).not.toBeNull()
    }
    try {
      release()
      await f.drain()
      f.save()
      expect(f.hasTab()).toBe(true)
      if (change === 'same-clock-bound-hint') {
        expect(f.main.getWorkspaceSession().tabsByWorktree[f.worktree][0].ptyId).toBe('replacement')
      }
      expect(f.api.pty.kill).not.toHaveBeenCalled()
    } finally {
      if (reservation) {
        reservation.resolve({ id: 'replacement' })
        clearPaneSpawnReservation(key, reservation)
      }
    }
  })
}

it('does not arm a fresh scope over a newly created unsaved sibling', async () => {
  const f = connected('repo', false)
  f.main.setWorkspaceSession(buildWorkspaceSessionPayload(f.renderer.getState()))
  const sibling = f.renderer
    .getState()
    .createTab(f.worktree, undefined, undefined, { activate: false })
  f.close()
  await f.drain()
  f.save()
  expect(f.main.getWorkspaceSession().tabsByWorktree[f.worktree].map((tab) => tab.id)).toEqual([
    sibling.id
  ])
})

it('unavailable host preserves durable membership', async () => {
  const f = connected()
  wire.unavailable = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.close()
  await f.drain()
  f.save()
  expect(f.hasTab()).toBe(true)
})

it('same-clock reopen has a distinct identity', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const f = connected()
  f.close()
  expect(f.renderer.getState().reopenClosedTerminalTab(f.worktree)).toBe(true)
  expect(f.renderer.getState().tabsByWorktree[f.worktree][0].id).not.toBe(TAB)
  await f.drain()
})
