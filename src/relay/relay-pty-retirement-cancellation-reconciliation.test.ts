import { afterEach, expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'
import { confirmSettledSourceDeliveryCancellation } from '../main/providers/ssh-pty-source-delivery-state'

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

it.each(['exact', 'token', 'client-generation', 'owner-generation', 'terminal'])(
  'reconciles retired delivery through the source RPC only with exact ownership: %s',
  async (mode) => {
    const f = await createSourceRetirementPublicationFixture()
    disposals.push(f.dispose)
    const output = 'settled\r\n🌊'
    f.publication.publish('source', { data: output }, false)
    await f.acknowledge('source', output.length)
    const cleanup = f.prepare()
    cleanup.remove(() => {})
    const delivery = cleanup.delivery
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    const params = {
      id: mode === 'terminal' ? 'other' : delivery.id,
      deliveryToken: mode === 'token' ? 'unknown' : delivery.deliveryToken,
      clientGeneration: delivery.clientGeneration + (mode === 'client-generation' ? 1 : 0),
      ownerGeneration: delivery.ownerGeneration + (mode === 'owner-generation' ? 1 : 0)
    }
    const result = await f.request('pty.cancelDelivery', params)
    if (mode === 'exact') {
      expect(result.error).toBeUndefined()
      expect(result.result).toEqual({
        canceled: true,
        sentEndSu: output.length,
        creditedEndSu: output.length
      })
      expect((await f.request('pty.cancelDelivery', params)).result).toEqual(result.result)
      const confirmed = await confirmSettledSourceDeliveryCancellation(
        {
          request: async (method, params) => {
            const response = await f.request(method, { ...params })
            if (response.error) {
              throw new Error('source cancellation failed')
            }
            return response.result
          }
        },
        { ...f.source, bridgeId: 'bridge', destinationRuntimeId: 'destination' },
        delivery,
        () => {}
      )
      expect(confirmed.cancellation).toEqual(result.result)
    } else {
      expect(result.error).toBeDefined()
      expect(result.result).toBeUndefined()
    }
    expect(cancel).not.toHaveBeenCalled()
    expect(f.publication.accepts('source')).toBe(false)
    expect(f.publication.publish('other', { data: 'sibling' }, false)).toBe(true)
    expect(f.session.sourceDeliverySnapshotIfKnown(delivery)).toMatchObject({
      state: 'closed',
      receivedEndSu: output.length,
      sentEndSu: output.length,
      creditedEndSu: output.length,
      exitPublished: false
    })
  }
)
