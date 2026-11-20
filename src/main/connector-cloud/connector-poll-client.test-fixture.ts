// One poll client against a fake Orca Cloud, with a fresh profile folder and fake timers per test.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { ConnectorPollClient } from './connector-poll-client'
import { ConnectorAccountTransport } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

export const SERVER_NOW = 1_800_000_000_000
export const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const
export const base = { seq: 1, expiresAt: SERVER_NOW + 300_000, conversation }

// Each step lets a chain of fetches and seam answers run to its next timer.
export const settle = async (ms = 0): Promise<void> => {
  for (let step = 0; step < 50; step++) {
    await vi.advanceTimersByTimeAsync(ms / 50)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Call once per test file, at its top. */
export function pollClientHarness() {
  const state = { userDataPath: '', fake: new FakeConnectorCloud() }
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
      now: SERVER_NOW
    })
    state.userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-client-'))
    state.fake = new FakeConnectorCloud()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await ConnectorTurnEvents.settled()
    rmSync(state.userDataPath, { recursive: true, force: true })
  })
  return {
    get fake() {
      return state.fake
    },
    get userDataPath() {
      return state.userDataPath
    },
    /** `events` stands for one process's outbox; a new one models a restart. */
    startClient(
      seam = fakeSeam(),
      events = new ConnectorTurnEvents(state.userDataPath, 'ada'),
      configure?: (machine: ReturnType<typeof fakeMachine>) => void
    ) {
      const machine = fakeMachine(() => seam)
      configure?.(machine)
      const client = new ConnectorPollClient({
        transport: new ConnectorAccountTransport(
          state.fake.origin,
          state.fake.mintFor('ada'),
          state.fake.fetch
        ),
        events,
        seam: seam.seam,
        machine,
        random: () => 0.5
      })
      client.start()
      return { client, machine, ...seam }
    },
    poll(deliveries: unknown[], extra: Record<string, unknown> = {}) {
      state.fake.answerPoll({
        status: 200,
        body: { v: 1, serverNow: SERVER_NOW, holdMs: 50_000, deliveries, ...extra }
      })
    }
  }
}
