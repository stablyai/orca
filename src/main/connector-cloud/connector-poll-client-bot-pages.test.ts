import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_PATHS,
  type ConnectorBot
} from '../../shared/connectors/connector-cloud-contract'
import { isRecord, pollClientHarness, settle } from './connector-poll-client.test-fixture'

const h = pollClientHarness()

const bot = (index: number): ConnectorBot => ({
  id: `bot-${index}`,
  name: `Bot ${index}`,
  agent: 'claude',
  members: [],
  paused: false
})
const botList = (count: number): ConnectorBot[] => Array.from({ length: count }, (_, i) => bot(i))
const ids = (bots: ConnectorBot[]): string[] => bots.map((entry) => entry.id)
// How many bots a hello listed inline; null when it listed none.
const listed = (hello: unknown): number | null =>
  isRecord(hello) && Array.isArray(hello.bots) ? hello.bots.length : null

function startWith(bots: ConnectorBot[]) {
  const started = h.startClient()
  started.machine.botList = bots
  return started
}

describe('a machine with more bots than one hello lists', () => {
  it('registers every bot with a cloud that takes pages', async () => {
    h.fake.features = ['slack.teams', 'bots.pages']
    const bots = botList(45)
    const { client } = startWith(bots)
    await settle()
    expect(h.fake.registeredBots).toEqual(ids(bots))
    const pages = h.fake.requestsTo(CONNECTOR_PATHS.botPages)
    expect(pages).toHaveLength(Math.ceil(45 / CONNECTOR_CLIENT_LIMITS.maxHelloBots))
    expect(h.fake.hellos.at(-1)).toMatchObject({
      botPages: { pages: pages.length }
    })
    expect(h.fake.hellos.at(-1)).not.toHaveProperty('bots')
    client.stop()
  })

  it('never lists part of its bots before the cloud says it takes pages', async () => {
    h.fake.features = ['bots.pages']
    const bots = botList(25)
    // Registered by an earlier session; a first hello listing 20 would unregister five of them.
    h.fake.registeredBots = ids(bots)
    const { client } = startWith(bots)
    await settle()
    expect(h.fake.hellos[0]).not.toHaveProperty('bots')
    expect(h.fake.hellos.map(listed).filter((count) => count !== null)).toEqual([])
    expect(h.fake.registeredBots).toEqual(ids(bots))
    client.stop()
  })

  it('stages the pages again when the cloud lost them, and never registers a part', async () => {
    h.fake.features = ['bots.pages']
    const bots = botList(26)
    const before = ids(bots.slice(0, 25))
    h.fake.registeredBots = before
    h.fake.loseBotPages = true
    const { client } = startWith(bots)
    await settle()
    expect(h.fake.hellos.at(-1)).toHaveProperty('botPages')
    expect(h.fake.registeredBots).toEqual(before)
    h.fake.loseBotPages = false
    await settle(60_000)
    expect(h.fake.registeredBots).toEqual(ids(bots))
    const inventories = new Set(
      h.fake
        .requestsTo(CONNECTOR_PATHS.botPages)
        .map((request) => (isRecord(request.body) ? request.body.inventoryId : null))
    )
    expect(inventories.size).toBeGreaterThan(1)
    client.stop()
  })

  it('sends an older cloud the first bots in saved order, never more than it takes', async () => {
    h.fake.features = ['slack.teams']
    const bots = botList(25)
    const { client } = startWith(bots)
    await settle()
    expect(h.fake.requestsTo(CONNECTOR_PATHS.botPages)).toEqual([])
    expect(h.fake.registeredBots).toEqual(ids(bots.slice(0, CONNECTOR_CLIENT_LIMITS.maxHelloBots)))
    // Left out until the answer, then never more than an older cloud's schema takes.
    expect(h.fake.hellos.map(listed)).toEqual([null, CONNECTOR_CLIENT_LIMITS.maxHelloBots])
    client.stop()
  })

  it('lists a few bots inline in its one hello, as before', async () => {
    h.fake.features = ['bots.pages']
    const bots = botList(3)
    const { client } = startWith(bots)
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    expect(h.fake.hellos[0]).toMatchObject({ bots })
    expect(h.fake.requestsTo(CONNECTOR_PATHS.botPages)).toEqual([])
    client.stop()
  })

  it('asks again what a cloud rolled back to an older one takes, then sends its first bots', async () => {
    h.fake.features = ['bots.pages']
    const bots = botList(25)
    const { client, machine } = startWith(bots)
    await settle()
    expect(h.fake.registeredBots).toEqual(ids(bots))
    h.fake.features = []
    machine.botList = botList(26)
    client.sayChanged()
    await settle()
    // The held poll ends, and the next cycle says hello again.
    h.poll([])
    await settle(60_000)
    expect(h.fake.registeredBots).toEqual(ids(bots.slice(0, CONNECTOR_CLIENT_LIMITS.maxHelloBots)))
    expect(listed(h.fake.hellos.at(-1))).toBe(CONNECTOR_CLIENT_LIMITS.maxHelloBots)
    client.stop()
  })

  it('counts as connected only once a hello listed the bots, not the one that left them out', async () => {
    h.fake.features = ['bots.pages']
    h.fake.forced.set(CONNECTOR_PATHS.botPages, { status: 500, body: { error: 'internal' } })
    const { client } = startWith(botList(25))
    let taken = false
    void client.helloTaken(new AbortController().signal).then(() => (taken = true))
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    expect(taken).toBe(false)
    h.fake.forced.delete(CONNECTOR_PATHS.botPages)
    await settle(60_000)
    expect(taken).toBe(true)
    expect(h.fake.registeredBots).toHaveLength(25)
    client.stop()
  })
})
