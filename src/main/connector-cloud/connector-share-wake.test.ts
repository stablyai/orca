import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { ConnectorCloud } from './connector-cloud'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()
const OFFER = { wakeUrl: 'wss://wake.test/v1/connector/wake', safetyPollMs: 180_000 }

function connectorCloud(options: { sharesChanged?: () => void; account?: string | null }) {
  const seam = fakeSeam()
  const machine = fakeMachine(() => seam)
  machine.wanted = false
  if (options.sharesChanged) {
    machine.sharesChanged = options.sharesChanged
  }
  const account = options.account === undefined ? 'ada' : options.account
  const cloud = new ConnectorCloud({
    userDataPath: h.userDataPath,
    origin: h.fake.origin,
    machine,
    account: () => account,
    isFenced: () => false,
    mintFor: (name) => h.fake.mintFor(name),
    fetchImpl: h.fake.fetch,
    wakeSocketFactory: h.wake.factory
  })
  cloud.connect()
  return { cloud, machine }
}

describe('connector share wake', () => {
  it('a signed-in desktop with no connector holds only the wake socket until a client runs', async () => {
    h.fake.wakeOffer = OFFER
    h.fake.mintsWakeTokens = true
    const sharesChanged = vi.fn()
    const { cloud, machine } = connectorCloud({ sharesChanged })
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    expect(h.fake.hellos[0]).toMatchObject({
      features: expect.arrayContaining(['shares-changed-v1'])
    })
    const socket = h.wake.dialed[0]
    socket.accept()
    await settle(60 * 60_000 - 1_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(0)
    expect(h.fake.hellos).toHaveLength(1)
    socket.sharesChanged()
    socket.wake()
    await settle()
    expect(sharesChanged).toHaveBeenCalledTimes(1)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(0)

    // A connector of its own: the poll client takes over, with its own socket.
    machine.wanted = true
    machine.inputsChanged()
    await settle()
    expect(socket.closed).toBe(true)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.wake.dialed).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)

    // Its last connector gone: once the client settles and stops, the wake socket alone is back.
    machine.wanted = false
    machine.inputsChanged()
    await settle()
    expect(h.wake.dialed[1].closed).toBe(true)
    expect(h.wake.dialed).toHaveLength(3)
    expect(h.fake.hellos.at(-1)).toMatchObject({
      features: expect.arrayContaining(['shares-changed-v1'])
    })
    cloud.signOutStarted()
  })

  it('holds nothing without the shares_changed handler, or signed out', async () => {
    h.fake.wakeOffer = OFFER
    h.fake.mintsWakeTokens = true
    connectorCloud({})
    connectorCloud({ sharesChanged: () => {}, account: null })
    await settle()
    expect(h.fake.hellos).toHaveLength(0)
    expect(h.wake.dialed).toHaveLength(0)
  })

  it('a sign-out drops the wake socket', async () => {
    h.fake.wakeOffer = OFFER
    h.fake.mintsWakeTokens = true
    const { cloud } = connectorCloud({ sharesChanged: () => {} })
    await settle()
    h.wake.dialed[0].accept()
    cloud.signOutStarted()
    expect(h.wake.dialed[0].closed).toBe(true)
  })
})
