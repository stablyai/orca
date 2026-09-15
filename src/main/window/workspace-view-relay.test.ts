import { describe, expect, it, vi } from 'vitest'
import { WorkspaceViewRelay } from './workspace-view-relay'

describe('workspace view relay', () => {
  it('accepts acknowledgement only from the requested renderer and only once', async () => {
    let requestId = ''
    const relay = new WorkspaceViewRelay()
    const request = relay.request(
      2,
      (id) => {
        requestId = id
      },
      'import',
      { draft: 'unsaved' }
    )
    expect(relay.reply(3, requestId, { ok: true })).toBe(false)
    expect(relay.reply(2, requestId, { ok: true })).toBe(true)
    expect(await request).toEqual({ ok: true })
    expect(relay.reply(2, requestId, { ok: true })).toBe(false)
  })
  it('rejects outstanding imports when the destination renderer closes', async () => {
    const relay = new WorkspaceViewRelay()
    const request = relay.request(2, vi.fn(), 'import', {})
    relay.disconnect(2)
    await expect(request).rejects.toThrow('Destination closed')
  })
})
