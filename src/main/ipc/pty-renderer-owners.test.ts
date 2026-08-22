import { describe, expect, it, vi } from 'vitest'
import { PtyRendererOwners } from './pty-renderer-owners'

function makeRenderer(id: number) {
  return {
    id,
    getType: () => 'window',
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
}

describe('PtyRendererOwners', () => {
  it('claims each PTY for exactly one registered renderer', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)

    expect(owners.claim('pty-1', first as never)).toEqual({
      webContentsId: 1,
      generation: 0
    })
    expect(owners.claim('pty-1', first as never)).toEqual({
      webContentsId: 1,
      generation: 0
    })
    expect(() => owners.claim('pty-1', second as never)).toThrow('pty_renderer_owned')
    expect(owners.owns('pty-1', first as never)).toBe(true)
    expect(owners.owns('pty-1', second as never)).toBe(false)
    expect(owners.getTarget('pty-1')).toBe(first)
  })

  it('tracks dispatcher readiness per renderer', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)
    owners.markDispatcherReady(first as never)

    expect(owners.isDispatcherReadyFor('pty-unclaimed')).toBe(false)
    owners.claim('pty-1', first as never)
    owners.claim('pty-2', second as never)
    expect(owners.isDispatcherReadyFor('pty-1')).toBe(true)
    expect(owners.isDispatcherReadyFor('pty-2')).toBe(false)
  })

  it('waits for dispatcher readiness and rejects when the renderer closes', async () => {
    const owners = new PtyRendererOwners()
    const ready = makeRenderer(1)
    const closed = makeRenderer(2)
    owners.registerRenderer(ready as never)
    owners.registerRenderer(closed as never)

    const readyPromise = owners.waitUntilDispatcherReady(ready as never, 100)
    const closedPromise = owners.waitUntilDispatcherReady(closed as never, 100)
    owners.markDispatcherReady(ready as never)
    owners.removeRenderer(closed as never)

    await expect(readyPromise).resolves.toBeUndefined()
    await expect(closedPromise).rejects.toThrow('pty_renderer_destroyed')
  })

  it('isolates active, visible, hidden, and interest state by owner', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)
    owners.claim('pty-1', first as never)
    owners.claim('pty-2', second as never)
    owners.setActive(first as never, 'pty-1', true)
    owners.setVisible(first as never, 'pty-1', true)
    owners.setHidden(first as never, 'pty-1', true)
    owners.setInterested(first as never, 'pty-1', true)

    expect(() => owners.setActive(second as never, 'pty-1', false)).toThrow(
      'pty_renderer_not_owner'
    )
    owners.beginReload(second as never)

    expect(owners.getViewState('pty-1')).toEqual({
      active: true,
      visible: true,
      hidden: true,
      interested: true
    })
  })

  it('advances only the reloading owner generation', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)
    owners.claim('pty-1', first as never)
    owners.claim('pty-2', second as never)

    expect(owners.beginReload(first as never)).toEqual(['pty-1'])

    expect(owners.getOwner('pty-1')).toEqual({ webContentsId: 1, generation: 1 })
    expect(owners.getOwner('pty-2')).toEqual({ webContentsId: 2, generation: 0 })
  })

  it('hands ownership to a ready target and rejects late old-owner events', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)
    owners.claim('pty-1', first as never)
    owners.markDispatcherReady(second as never)

    const result = owners.handoff(['pty-1'], first as never, second as never)

    expect(result).toEqual([{ id: 'pty-1', fromGeneration: 0, toGeneration: 1 }])
    expect(owners.owns('pty-1', first as never)).toBe(false)
    expect(owners.owns('pty-1', second as never)).toBe(true)
    expect(owners.isDispatcherReadyFor('pty-1')).toBe(true)
  })

  it('removes only the closed renderer and reports its orphaned PTYs', () => {
    const owners = new PtyRendererOwners()
    const first = makeRenderer(1)
    const second = makeRenderer(2)
    owners.registerRenderer(first as never)
    owners.registerRenderer(second as never)
    owners.claim('pty-1', first as never)
    owners.claim('pty-2', second as never)

    expect(owners.removeRenderer(first as never)).toEqual(['pty-1'])
    expect(owners.getTarget('pty-1')).toBeNull()
    expect(owners.getTarget('pty-2')).toBe(second)
  })
})
