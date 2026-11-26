import { expect, it } from 'vitest'
import { z } from 'zod'
import { connectorAskerImages } from '../external-conversations/connector-asker-images'
import { ConnectorCloud } from './connector-cloud'
import { SIGNED_OUT } from './connector-cloud-request'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'

const harness = pollClientHarness()
const PATH = '/fixture-file-action'
const Result = z.object({ ok: z.literal(true) })

it.each([10, 100])('uses no synchronous account reads for %d file actions', async (actions) => {
  const { fake } = harness
  fake.features = ['files.direct']
  fake.forced.set(PATH, { status: 200, body: { ok: true } })
  let account = 'ada'
  let reads = 0
  let fenced = false
  const seam = fakeSeam()
  const connector = new ConnectorCloud({
    userDataPath: harness.userDataPath,
    origin: fake.origin,
    machine: fakeMachine(() => seam),
    account: () => {
      reads += 1
      return account
    },
    isFenced: () => fenced,
    mintFor: (current) => fake.mintFor(current),
    fetchImpl: fake.fetch
  })
  try {
    connector.connect()
    await settle()
    reads = 0
    for (let index = 0; index < actions; index += 1) {
      const transport = connector.fileActionTransport()!
      expect(await transport.call(PATH, {}, Result)).toEqual({ ok: true, value: { ok: true } })
    }
    const transport = connector.fileActionTransport()!
    fake.forced.set(PATH, { status: 503 })
    expect(await transport.call(PATH, {}, Result)).toMatchObject({ ok: false, status: 503 })
    fake.forced.set(PATH, { status: 200, body: { ok: true } })
    expect(await transport.call(PATH, {}, Result)).toMatchObject({ ok: true })
    expect(reads).toBe(0)

    account = 'bea'
    connector.accountChanged()
    expect(await transport.call(PATH, {}, Result)).toEqual(SIGNED_OUT)
    expect(fake.requestsTo(PATH)).toHaveLength(actions + 2)
  } finally {
    fenced = true
    connector.fence()
  }
})

it('still offers reconnection when a refresh is rejected and polling can retry', async () => {
  const { fake } = harness
  const seam = fakeSeam()
  let fenced = false
  const connector = new ConnectorCloud({
    userDataPath: harness.userDataPath,
    origin: fake.origin,
    machine: fakeMachine(() => seam),
    account: () => 'ada',
    isFenced: () => fenced,
    mintFor: (account) => fake.mintFor(account),
    fetchImpl: fake.fetch
  })
  try {
    connector.connect()
    await settle()
    fake.mintSessionRefused = true
    fake.answerPoll({ status: 401, body: { error: 'invalid_token' } })
    await settle()
    expect(connector.botListFacts()).toMatchObject({
      connectorStatus: 'needs-sign-in',
      connectorNeedsSignIn: true
    })
  } finally {
    fenced = true
    connector.fence()
  }
})

it.each([20, 200])('bounds image stores for %d simultaneous deliveries', async (count) => {
  const firstFour = Promise.withResolvers<void>()
  const finishStores = Promise.withResolvers<string>()
  const retired = new AbortController()
  let active = 0
  let maximum = 0
  const get = connectorAskerImages({
    reader: () => async () => ({
      ok: true,
      value: {
        ok: true,
        result: { download: { url: 'https://fixture.invalid/file', ticket: 'ticket' } }
      }
    }),
    fetch: async () => new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)),
    store: async () => {
      active += 1
      maximum = Math.max(active, maximum)
      if (active === 4) {
        firstFour.resolve()
      }
      try {
        return { path: await finishStores.promise }
      } finally {
        active -= 1
      }
    }
  })
  const request = (index: number, signal: AbortSignal) =>
    get({
      botId: 'bot',
      conversation: { source: 'slack', externalId: String(index) },
      asker: {
        userId: 'U1',
        role: 'owner',
        place: { kind: 'public_channel', id: 'C1' },
        text: '@bot\n[image: fixture.png, file FQA]',
        messageRef: 'slack:T1:C1:2.0:2.0',
        context: []
      },
      signal
    })
  const work = Array.from({ length: count }, (_, index) => request(index, retired.signal))
  await firstFour.promise
  retired.abort()
  await Promise.all(work)
  const successor = request(count, new AbortController().signal)
  try {
    expect(active).toBe(4)
  } finally {
    finishStores.resolve('/fixture/image.png')
  }
  await expect(successor).resolves.toHaveLength(1)
  expect(maximum).toBe(4)
})
