import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorPollClient } from './connector-poll-client'
import { ConnectorAccountTransport } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

let userDataPath: string
let fake: FakeConnectorCloud

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-hello-answer-'))
  fake = new FakeConnectorCloud()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a hello answer', () => {
  it('reaches the machine with what the cloud takes and the hooks deleted while it was away', async () => {
    fake.features = ['webhooks']
    fake.webhookTombstones = ['wh_7Kx2pQ9mZbV4tL1r']
    const seam = fakeSeam()
    const machine = fakeMachine(() => seam)
    const answered = vi.fn()
    machine.helloAnswered = answered
    const client = new ConnectorPollClient({
      transport: new ConnectorAccountTransport(fake.origin, fake.mintFor('ada'), fake.fetch),
      events: new ConnectorTurnEvents(userDataPath, 'ada'),
      seam: seam.seam,
      machine,
      random: () => 0.5
    })
    client.start()
    for (let step = 0; step < 50; step++) {
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(answered).toHaveBeenCalledWith({
      helloRev: expect.any(Number),
      features: ['webhooks'],
      webhookTombstones: ['wh_7Kx2pQ9mZbV4tL1r']
    })
    client.stop()
  })
})
