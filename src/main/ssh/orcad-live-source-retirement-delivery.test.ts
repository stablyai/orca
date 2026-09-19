import { expect, it } from 'vitest'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  createOrcadLiveSourceRetirementDelivery,
  reconstructOrcadLiveSourceRetirementDelivery
} from './orcad-live-source-retirement-delivery'

function fixture() {
  const captureBoundary = {
    version: 1,
    identity,
    throughSeq: 1,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      providerGeneration: 2,
      clientGeneration: 3,
      ownerGeneration: identity.sourceOwnerGeneration,
      deliveryToken: 'delivery',
      state: 'active',
      windowSu: 256,
      receivedEndSu: 10,
      sentEndSu: 10,
      creditedEndSu: 10,
      generationClosed: false,
      exitPublished: false
    }
  }
  const settlement = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 901,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'delivery',
    fromSourceEndSu: 10,
    throughSourceEndSu: 20
  }
  return { identity, captureBoundary, settlement, providerGeneration: 901 }
}

it('joins contiguous local settlement while preserving captured host generation and window', () => {
  const f = fixture()
  const result = createOrcadLiveSourceRetirementDelivery(f)
  expect(result).toEqual({
    ...f.captureBoundary.delivery,
    receivedEndSu: 20,
    sentEndSu: 20,
    creditedEndSu: 20
  })
  expect(Object.isFrozen(result)).toBe(true)
  expect(f.captureBoundary.delivery.creditedEndSu).toBe(10)
})

it('allows an unchanged boundary covered by the local settlement range', () => {
  const f = fixture()
  f.settlement.fromSourceEndSu = 5
  f.settlement.throughSourceEndSu = 10
  expect(createOrcadLiveSourceRetirementDelivery(f)).toEqual(f.captureBoundary.delivery)
})

it('reconstructs a historical boundary without treating local provider generation as current authority', () => {
  const f = fixture()
  const { providerGeneration: _current, ...historical } = f
  expect(reconstructOrcadLiveSourceRetirementDelivery(historical)).toEqual(
    createOrcadLiveSourceRetirementDelivery(f)
  )
  historical.settlement.providerGeneration = 902
  expect(reconstructOrcadLiveSourceRetirementDelivery(historical).providerGeneration).toBe(2)
  expect(() => createOrcadLiveSourceRetirementDelivery(f)).toThrow('unverifiable')
})

it.each([
  { id: 'other' },
  { ptyIncarnation: 'other' },
  { providerGeneration: 902 },
  { clientGeneration: 4 },
  { ownerGeneration: 99 },
  { deliveryToken: 'other' },
  { fromSourceEndSu: 11 },
  { fromSourceEndSu: 5, throughSourceEndSu: 9 },
  { throughSourceEndSu: Number.MAX_SAFE_INTEGER + 1 },
  { fromSourceEndSu: -1 }
])('refuses mismatched, gapped or invalid settlement %j', (patch) => {
  const f = fixture()
  expect(() =>
    createOrcadLiveSourceRetirementDelivery({ ...f, settlement: { ...f.settlement, ...patch } })
  ).toThrow()
  if (!('providerGeneration' in patch)) {
    expect(() =>
      reconstructOrcadLiveSourceRetirementDelivery({
        ...f,
        settlement: { ...f.settlement, ...patch }
      })
    ).toThrow()
  }
})

it('refuses another capture identity even with matching delivery fields', () => {
  const f = fixture()
  expect(() =>
    createOrcadLiveSourceRetirementDelivery({
      ...f,
      captureBoundary: { ...f.captureBoundary, identity: { ...identity, bridgeId: 'other' } }
    })
  ).toThrow()
})
