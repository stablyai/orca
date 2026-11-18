import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { ConnectorCloud } from './connector-cloud'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { FAKE_BOT, fakeMachine, fakeSeam, type FakeSeam } from './fake-connector-seam.test-fixture'

let userDataPath: string
let outbox: string
let fake: FakeConnectorCloud
let enabled: boolean
let account: string | null
let quitting: boolean
let seam: FakeSeam
let machine: ReturnType<typeof fakeMachine>

function connectorCloud(onStatusChanged?: () => void): ConnectorCloud {
  return new ConnectorCloud({
    onStatusChanged,
    userDataPath,
    origin: fake.origin,
    machine,
    account: () => account,
    isFenced: () => quitting,
    mintFor: (who) => fake.mintFor(who),
    fetchImpl: fake.fetch
  })
}

const turnEnd = {
  kind: 'turn-ended',
  conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' },
  paneKey: 'tab:1',
  turnId: 1,
  at: 2,
  stopReason: null
}

beforeEach(() => {
  vi.useFakeTimers()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-cloud-'))
  outbox = join(userDataPath, 'connector-turn-outbox.json')
  fake = new FakeConnectorCloud()
  enabled = true
  account = 'ada'
  quitting = false
  seam = fakeSeam()
  machine = fakeMachine(() => (enabled ? seam : null))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorCloud', () => {
  it('holds the poll only while signed in and on, and stops on disable and sign-out', async () => {
    account = null
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(0)

    account = 'ada'
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)

    enabled = false
    seam.disable()
    machine.inputsChanged()
    enabled = true
    seam = fakeSeam()
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)

    cloud.signOutStarted()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(2)
  })

  it('stops on a refused sign-in instead of retrying, and asks again after a new sign-in', async () => {
    fake.mintRefusal = 'machine_mismatch'
    const onStatusChanged = vi.fn()
    const cloud = new ConnectorCloud({
      userDataPath,
      origin: fake.origin,
      machine,
      account: () => account,
      isFenced: () => quitting,
      mintFor: (who) => fake.mintFor(who),
      onStatusChanged,
      fetchImpl: fake.fetch
    })
    cloud.connect()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(fake.mintAttempts).toBe(1)
    expect(cloud.needsSignIn()).toBe(true)
    expect(cloud.status()).toBe('signed-out')
    expect(onStatusChanged).toHaveBeenCalledTimes(1)

    fake.mintRefusal = null
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.needsSignIn()).toBe(false)
    expect(cloud.status()).toBe('ok')
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
  })

  it("says whether events reach this host's bots: signed out, can't reach Orca Cloud, or ok", async () => {
    account = null
    const changed = vi.fn()
    const cloud = connectorCloud(changed)
    cloud.connect()
    expect(cloud.status()).toBe('signed-out')

    account = 'ada'
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.status()).toBe('ok')

    changed.mockClear()
    fake.answerPoll({ status: 503 })
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.status()).toBe('unreachable')
    expect(changed).toHaveBeenCalled()

    changed.mockClear()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cloud.status()).toBe('ok')
    expect(changed).toHaveBeenCalled()

    changed.mockClear()
    cloud.signOutStarted()
    expect(cloud.status()).toBe('signed-out')
    expect(changed).toHaveBeenCalled()
  })

  it("says why the cloud refuses this host, and waits the cloud's Retry-After before asking again", async () => {
    const changed = vi.fn()
    const cloud = connectorCloud(changed)
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.status()).toBe('ok')

    changed.mockClear()
    fake.answerPoll({
      status: 403,
      body: { error: 'host_key_limit', message: 'Too\u0007 many\u202e\nmachines.\u0000' },
      headers: { 'retry-after': '300' }
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.botListFacts()).toMatchObject({
      connectorStatus: 'refused',
      connectorMessage: 'Too many machines.'
    })
    expect(changed).toHaveBeenCalled()

    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    await vi.advanceTimersByTimeAsync(299_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)

    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(1_010)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(polls)
    expect(cloud.botListFacts()).toMatchObject({ connectorStatus: 'ok' })
    expect(cloud.botListFacts()).not.toHaveProperty('connectorMessage')
  })

  it('asks for sign-in only when the mint refuses the sign-in, not when the connector API answers 401', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)

    fake.answerPoll({ status: 401, body: { error: 'invalid_token' } })
    fake.answerPoll({ status: 401, body: { error: 'invalid_token' } })
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.botListFacts().connectorStatus).not.toBe('needs-sign-in')
    expect(cloud.botListFacts()).not.toHaveProperty('connectorNeedsSignIn')

    fake.mintSessionRefused = true
    fake.answerPoll({ status: 401, body: { error: 'invalid_token' } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cloud.botListFacts()).toMatchObject({
      connectorStatus: 'needs-sign-in',
      connectorNeedsSignIn: true
    })

    fake.mintSessionRefused = false
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cloud.botListFacts()).toMatchObject({ connectorStatus: 'ok' })
    expect(cloud.botListFacts()).not.toHaveProperty('connectorNeedsSignIn')
  })

  it('connects only while the cloud can bring this machine work, and at once for the first connector', async () => {
    machine.wanted = false
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requests).toHaveLength(0)

    machine.wanted = true
    machine.botList = [FAKE_BOT]
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
  })

  it('after the last connector goes, stops only once the cloud has the hello saying so and every event owed', async () => {
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    machine.botList = [FAKE_BOT]
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)

    machine.wanted = false
    machine.botList = [{ ...FAKE_BOT, name: 'Home only' }]
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.hellos.at(-1)).toMatchObject({ bots: [{ name: 'Home only' }] })
    // The snapshot is still owed, so the poll stays held.
    expect(cloud.cloudFeatures()).not.toBeNull()
    expect(fake.events).toHaveLength(0)

    fake.forced.delete(CONNECTOR_PATHS.events)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
    expect(cloud.cloudFeatures()).toBeNull()
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
  })

  it('after the last connector goes, waits for a linked turn still running to end', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    const pane = {
      conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const,
      worktreeId: 'w1',
      paneKey: 'tab:1'
    }
    seam.emit({ ...pane, kind: 'turn-started', at: 1 })
    machine.wanted = false
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cloud.cloudFeatures()).not.toBeNull()

    seam.emit({ ...pane, kind: 'turn-ended', turnId: 1, stopReason: null, at: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended' }))
    expect(cloud.cloudFeatures()).toBeNull()
  })

  it('with no connector left, still connects to send turn ends an earlier run left on disk, then stops', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'ada', turnEnds: [turnEnd] }))
    machine.wanted = false
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended' }))
    expect(existsSync(outbox)).toBe(false)
    expect(cloud.cloudFeatures()).toBeNull()
  })

  it('keeps the connection when a connector comes back before the flush', async () => {
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    machine.wanted = false
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(10)
    machine.wanted = true
    machine.inputsChanged()
    fake.forced.delete(CONNECTOR_PATHS.events)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.events).not.toHaveLength(0)
    expect(cloud.cloudFeatures()).not.toBeNull()
  })

  it('holds the connection through a call that needs the cloud to know the bots, then lets it go', async () => {
    machine.wanted = false
    machine.botList = [FAKE_BOT]
    const cloud = connectorCloud()
    cloud.connect()
    const held = cloud.withConnection(async () => fake.hellos.length)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(held).resolves.toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cloud.cloudFeatures()).toBeNull()
  })

  it('says a hello as soon as a bot change alters what it lists', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    machine.botList = [FAKE_BOT]
    machine.inputsChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
  })

  it('stays stopped while a sign-out runs, whatever refreshes or toggles happen meanwhile', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    // The account being signed out is still readable until the sign-out completes.
    cloud.signOutStarted()
    machine.inputsChanged()
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    account = null
    cloud.signOutFinished()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    account = 'ada'
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)
  })

  it('resumes when the sign-out ends with a sign-in that finished meanwhile', async () => {
    account = null
    const cloud = connectorCloud()
    cloud.connect()
    cloud.signOutStarted()
    account = 'ada'
    cloud.accountChanged()
    cloud.signOutFinished()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
  })

  it('keeps pending turn ends for the same account, and drops them on a switch or sign-out', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'ada', turnEnds: [turnEnd] }))
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    cloud.accountChanged()
    expect(existsSync(outbox)).toBe(true)

    fake.signedIn.add('grace')
    account = 'grace'
    cloud.accountChanged()
    expect(existsSync(outbox)).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.minted.at(-1)?.account).toBe('grace')

    writeFileSync(outbox, JSON.stringify({ account: 'grace', turnEnds: [turnEnd] }))
    const restarted = connectorCloud()
    restarted.signOutStarted()
    expect(existsSync(outbox)).toBe(false)
  })

  it('never sends turn ends another account left before a relaunch', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'grace', turnEnds: [turnEnd] }))
    connectorCloud().connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
  })

  it('stops when Orca quits or relaunches into another profile, keeping pending turn ends', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'ada', turnEnds: [turnEnd] }))
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    quitting = true
    account = 'grace'
    cloud.fence()
    machine.inputsChanged()
    cloud.accountChanged()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    expect(fake.minted.every((minted) => minted.account === 'ada')).toBe(true)
    expect(existsSync(outbox)).toBe(true)
  })
})
