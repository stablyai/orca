import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why this file is separate: the swap in writeAsync is async, so a writer parked on its
// rename has already cleared the generation guard and nothing downstream can veto it.
// flushOrThrow runs synchronously from session checkpoints and renderer shutdown, so a
// stale view landing on top of it is a real loss. Gating rename is the only way to pin it.

const gate = vi.hoisted(() => ({
  blockRename: false,
  blockAfterRename: false,
  waiters: [] as (() => void)[],
  afterRenameWaiters: [] as (() => void)[],
  renameCompleted: [] as (() => void)[],
  renameCalls: 0,
  failUnlink: false
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  const unlinkSync = ((...args: Parameters<typeof actual.unlinkSync>) => {
    if (gate.failUnlink) {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    return actual.unlinkSync(...args)
  }) as typeof actual.unlinkSync
  return { ...actual, unlinkSync }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const rename = (async (...args: Parameters<typeof actual.rename>) => {
    gate.renameCalls += 1
    if (gate.blockRename) {
      await new Promise<void>((resolve) => gate.waiters.push(resolve))
    }
    const result = await actual.rename(...args)
    gate.renameCompleted.splice(0).forEach((resolve) => resolve())
    if (gate.blockAfterRename) {
      await new Promise<void>((resolve) => gate.afterRenameWaiters.push(resolve))
    }
    return result
  }) as typeof actual.rename
  return { ...actual, rename }
})

describe('ActiveViewPreference sync flush vs. parked async rename', () => {
  let dir: string
  const viewFile = (): string => join(dir, 'active-view.json')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-active-view-'))
    gate.blockRename = false
    gate.blockAfterRename = false
    gate.waiters = []
    gate.afterRenameWaiters = []
    gate.renameCompleted = []
    gate.renameCalls = 0
    gate.failUnlink = false
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a write parked on its rename cannot overwrite a later flushOrThrow', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')

    gate.blockRename = true
    pref.set('activity')
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))
    // Why grab it now: flushOrThrow drops pendingWrite, so waitForPendingWrite would
    // return before the released rename has actually landed.
    const inflight = (pref as unknown as { pendingWrite: Promise<void> | null }).pendingWrite

    // A session checkpoint fires while that write is still parked.
    pref.set('tasks')
    pref.flushOrThrow()
    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')

    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await inflight

    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('an unlink veto failure queues a newest-value correction', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')

    gate.blockRename = true
    pref.set('activity')
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))

    pref.set('tasks')
    gate.failUnlink = true
    expect(() => pref.flushOrThrow()).toThrow('busy')

    gate.failUnlink = false
    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await pref.waitForPendingWrite()

    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('a completed stale rename cannot regress the persisted marker', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')
    const renameCompleted = new Promise<void>((resolve) => gate.renameCompleted.push(resolve))

    gate.blockAfterRename = true
    pref.set('activity')
    await renameCompleted

    pref.set('tasks')
    pref.flushOrThrow()
    gate.blockAfterRename = false
    gate.afterRenameWaiters.splice(0).forEach((resolve) => resolve())
    await pref.waitForPendingWrite()

    pref.set('activity')
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('activity')
    })
    await pref.waitForPendingWrite()
  })

  it('a pending flush drains a view changed during its rename', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')

    gate.blockRename = true
    pref.set('activity')
    const flush = pref.flushPendingAsync()
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))

    pref.set('tasks')
    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await flush

    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')
    expect(gate.renameCalls).toBe(2)
  })

  it('coalesces concurrent pending flushes while draining the newest view', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')

    gate.blockRename = true
    pref.set('activity')
    const firstFlush = pref.flushPendingAsync()
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))

    pref.set('tasks')
    const secondFlush = pref.flushPendingAsync()
    expect(secondFlush).toBe(firstFlush)
    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await Promise.all([firstFlush, secondFlush])

    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')
    expect(gate.renameCalls).toBe(2)
  })

  it('keeps an unabortable shared drain alive when an attached signal aborts', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')
    const controller = new AbortController()

    gate.blockRename = true
    pref.set('activity')
    const flush = pref.flushPendingAsync()
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))
    expect(pref.flushPendingAsync(controller.signal)).toBe(flush)

    pref.set('tasks')
    controller.abort()
    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await expect(flush).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(viewFile(), 'utf-8')).activeView).toBe('tasks')
    expect(gate.renameCalls).toBe(2)
  })

  it('stops an abortable-only drain after its signal aborts', async () => {
    const { ActiveViewPreference } = await import('./active-view-preference')
    const pref = new ActiveViewPreference(join(dir, 'orca-data.json'), 'terminal')
    const controller = new AbortController()

    gate.blockRename = true
    pref.set('activity')
    const flush = pref.flushPendingAsync(controller.signal)
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))

    controller.abort()
    gate.blockRename = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await expect(flush).rejects.toThrow('Active-view flush aborted')
    expect(gate.renameCalls).toBe(1)
  })
})
