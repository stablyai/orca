import { expect, it, vi } from 'vitest'
import { confirmSettledSourceDeliveryCancellation } from './ssh-pty-source-delivery-state'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const delivery = {
  id: identity.terminalId,
  ptyIncarnation: identity.incarnationId,
  providerGeneration: 2,
  clientGeneration: 3,
  ownerGeneration: identity.sourceOwnerGeneration,
  deliveryToken: 'token',
  state: 'active',
  windowSu: 256,
  receivedEndSu: 10,
  sentEndSu: 10,
  creditedEndSu: 10,
  generationClosed: false,
  exitPublished: false
}
const proof = { canceled: true, sentEndSu: 10, creditedEndSu: 10 }

it('requires exact host drainage, forwards options and returns sanitized frozen proof', async () => {
  const request = vi.fn(async () => ({ ...proof, credential: 'unexpected' }))
  const authority = vi.fn()
  const options = { signal: new AbortController().signal, timeoutMs: 100 }
  const result = await confirmSettledSourceDeliveryCancellation(
    { request },
    identity,
    delivery,
    authority,
    options
  )
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'pty.cancelDelivery',
    {
      id: identity.terminalId,
      clientGeneration: 3,
      ownerGeneration: identity.sourceOwnerGeneration,
      deliveryToken: 'token'
    },
    options
  )
  expect(authority).toHaveBeenCalledTimes(2)
  expect(result.cancellation).toEqual(proof)
  expect(Object.isFrozen(result.cancellation)).toBe(true)
  expect(Object.isFrozen(result.delivery)).toBe(true)
})

it.each([
  { canceled: false },
  { sentEndSu: 11, creditedEndSu: 11 },
  { sentEndSu: 9, creditedEndSu: 9 },
  { creditedEndSu: 8 },
  { creditedEndSu: 11 },
  { sentEndSu: Number.NaN }
])('refuses mismatched or malformed host proof without retry %#', async (patch) => {
  const request = vi.fn(async () => ({ ...proof, ...patch }))
  await expect(
    confirmSettledSourceDeliveryCancellation({ request }, identity, delivery, () => {})
  ).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})

it.each([
  { creditedEndSu: 9 },
  { providerGeneration: 0 },
  { id: 'other' },
  { generationClosed: true }
])('rejects invalid expected delivery before cancellation %#', async (patch) => {
  const request = vi.fn()
  await expect(
    confirmSettledSourceDeliveryCancellation(
      { request },
      identity,
      { ...delivery, ...patch },
      () => {}
    )
  ).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})

it.each(['before', 'after'])('refuses authority loss %s RPC', async (stage) => {
  let current = stage !== 'before'
  const request = vi.fn(async () => {
    current = false
    return proof
  })
  await expect(
    confirmSettledSourceDeliveryCancellation({ request }, identity, delivery, () => {
      if (!current) {
        throw new Error('source authority lost')
      }
    })
  ).rejects.toThrow('source authority lost')
  expect(request).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1)
})

it.each(['before', 'after'])('refuses abort %s RPC', async (stage) => {
  const controller = new AbortController()
  if (stage === 'before') {
    controller.abort(new Error('cancelled'))
  }
  const request = vi.fn(async () => {
    controller.abort(new Error('cancelled'))
    return proof
  })
  await expect(
    confirmSettledSourceDeliveryCancellation({ request }, identity, delivery, () => {}, {
      signal: controller.signal
    })
  ).rejects.toThrow('cancelled')
  expect(request).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1)
})
