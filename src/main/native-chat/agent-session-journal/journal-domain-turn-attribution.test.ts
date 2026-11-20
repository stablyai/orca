import { afterEach, expect, it } from 'vitest'
import { turnRowsChat, turnRowsUser as user } from './journal-domain-turn-rows.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

const chat = () => turnRowsChat(cleanup)

const deliveryIds = (stamps: { deliveryId: string }[] | null) =>
  stamps?.map((stamp) => stamp.deliveryId) ?? null

it("stamps a turn with its opener's delivery and each send steered into it, not another turn's", () => {
  const f = chat()
  f.send('other-open', 1, user('earlier', 'delivery-other-open'), {
    turnItemId: 'turn-0',
    via: 'start'
  })
  f.item('turn-0', 2, { kind: 'turn', turnId: 'provider-turn-0', state: 'completed' })
  f.item('orca:open', 10, user('open', 'delivery-open'))
  f.alias('provider:open', 'orca:open')
  f.item('turn-1', 11, {
    kind: 'turn',
    turnId: 'provider-turn-1',
    state: 'running',
    userItemId: 'provider:open'
  })
  f.send('steered', 12, user('also this', 'delivery-steered'), {
    turnItemId: 'turn-1',
    via: 'steer'
  })
  f.send('elsewhere', 13, user('not this', 'delivery-elsewhere'), {
    turnItemId: 'turn-0',
    via: 'steer'
  })

  const attribution = f.read('provider-turn-1')
  expect(attribution.turnItemId).toBe('turn-1')
  expect(attribution.opener?.itemId).toBe('orca:open')
  expect(deliveryIds(attribution.stamps)).toEqual(['delivery-open', 'delivery-steered'])
})

it("stamps a turn with only its opener's delivery when nothing was steered into it", () => {
  const f = chat()
  f.item('orca:open', 10, user('open', 'delivery-open'))
  f.item('turn-1', 11, {
    kind: 'turn',
    turnId: 'provider-turn-1',
    state: 'completed',
    userItemId: 'orca:open'
  })

  const attribution = f.read('provider-turn-1')
  expect(attribution.opener?.itemId).toBe('orca:open')
  expect(deliveryIds(attribution.stamps)).toEqual(['delivery-open'])
})

it('proves nothing for a turn the journal does not hold', () => {
  const f = chat()
  f.item('orca:open', 10, user('open', 'delivery-open'))

  expect(f.read('provider-turn-missing')).toMatchObject({
    turnItemId: null,
    opener: null,
    stamps: null
  })
})

it('counts no send written after the turn ended, as the turn end read it', () => {
  const f = chat()
  f.item('orca:open', 10, user('open'))
  f.item('turn-1', 11, {
    kind: 'turn',
    turnId: 'provider-turn-1',
    state: 'completed',
    userItemId: 'orca:open'
  })
  f.send('late', 20, user('after the end', 'delivery-late'), {
    turnItemId: 'turn-1',
    via: 'steer'
  })

  expect(deliveryIds(f.read('provider-turn-1', 12).stamps)).toEqual([])
  expect(deliveryIds(f.read('provider-turn-1', 20).stamps)).toEqual(['delivery-late'])
})
