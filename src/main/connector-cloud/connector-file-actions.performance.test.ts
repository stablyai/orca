import { expect, it } from 'vitest'
import { z } from 'zod'
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
