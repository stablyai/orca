import { expect, it, vi } from 'vitest'
import { WorkspaceViewControlPublication } from './workspace-view-control-publication'

it('does not revoke unrelated sessions when an unresponsive window misses a publication', async () => {
  const publication = new WorkspaceViewControlPublication()
  const first = { alpha: { windowId: 1, viewId: 'a' }, beta: { windowId: 3, viewId: 'b' } }
  const send = vi.fn(
    async (_id: number, _snapshot: Record<string, { windowId: number; viewId: string }>) => {}
  )
  await publication.publish(first, new Set([1, 2, 3]), send)
  send.mockClear()
  send.mockImplementation(async (id) => {
    if (id === 3) {
      throw new Error('hung')
    }
  })
  await publication.publish(
    { ...first, alpha: { windowId: 2, viewId: 'copy' } },
    new Set([1, 2, 3]),
    send
  )
  expect(
    send.mock.calls.filter(([id]) => id === 1).every(([, snapshot]) => snapshot.beta.windowId === 3)
  ).toBe(true)
  expect(send.mock.calls.findLast(([id]) => id === 2)?.[1].alpha.windowId).toBe(2)
})

it('keeps the old controller if it cannot acknowledge revocation', async () => {
  const publication = new WorkspaceViewControlPublication()
  await publication.publish(
    { session: { windowId: 1, viewId: 'a' } },
    new Set([1, 2]),
    async () => {}
  )
  const send = vi.fn(
    async (id: number, _snapshot: Record<string, { windowId: number; viewId: string }>) => {
      if (id === 1) {
        throw new Error('hung')
      }
    }
  )
  await publication.publish({ session: { windowId: 2, viewId: 'b' } }, new Set([1, 2]), send)
  expect(send.mock.calls.findLast(([id]) => id === 2)?.[1].session).toEqual({
    windowId: 1,
    viewId: 'a'
  })
})
