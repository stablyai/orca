import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ComposioIngressStore } from './composio-events-ingress'
import { composioCallRouter, ComposioUpkeep } from './composio-upkeep'

describe('the Composio events hook’s router', () => {
  it('routes only the events hook’s calls; an expired sign-in posts a card, and the rest settle', async () => {
    const store = new ComposioIngressStore(
      join(mkdtempSync(join(tmpdir(), 'composio-route-')), 'e.json')
    )
    store.write('project-1', { automationId: 'ingress', hookId: 'ingress-hook', signed: true })
    const expired = vi.fn(async () => undefined)
    const route = composioCallRouter({ automations: () => [], expired, store })
    expect(await route('another-hook', { headers: {}, body: {} })).toBeNull()
    const lapsed = {
      type: 'composio.connected_account.expired',
      data: { id: 'ca_1', toolkit: { slug: 'gmail' } }
    }
    expect(await route('ingress-hook', { headers: {}, body: lapsed })).toEqual({
      kind: 'handled',
      reason: 'composio_sign_in_expired'
    })
    expect(expired).toHaveBeenCalledWith('ca_1', 'gmail')
    expect(await route('ingress-hook', { headers: {}, body: { metadata: {} } })).toEqual({
      kind: 'handled',
      reason: 'not_for_any_bot'
    })
    // A failed Reconnect card throws, so the call is offered again rather than lost.
    expired.mockRejectedValueOnce(new Error('offline'))
    await expect(route('ingress-hook', { headers: {}, body: lapsed })).rejects.toThrow('offline')
  })

  it('runs one upkeep pass at a time', async () => {
    let release = () => {}
    const pass = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const upkeep = new ComposioUpkeep(pass)
    const first = upkeep.run()
    void upkeep.run()
    release()
    await first
    expect(pass).toHaveBeenCalledTimes(1)
  })
})
