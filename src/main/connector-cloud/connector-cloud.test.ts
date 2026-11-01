import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import { ConnectorCloud } from './connector-cloud'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam, type FakeSeam } from './fake-connector-seam.test-fixture'

let userDataPath: string
let outbox: string
let fake: FakeConnectorCloud
let enabled: boolean
let account: string | null
let quitting: boolean
let seam: FakeSeam
let machine: ReturnType<typeof fakeMachine>

function connectorCloud(): ConnectorCloud {
  return new ConnectorCloud({
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
    machine.toggle()
    enabled = true
    seam = fakeSeam()
    machine.toggle()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)

    cloud.signOutStarted()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(2)
  })

  it('stays stopped while a sign-out runs, whatever refreshes or toggles happen meanwhile', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    // The account being signed out is still readable until the sign-out completes.
    cloud.signOutStarted()
    machine.toggle()
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
    machine.toggle()
    cloud.accountChanged()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    expect(fake.minted.every((minted) => minted.account === 'ada')).toBe(true)
    expect(existsSync(outbox)).toBe(true)
  })
})
