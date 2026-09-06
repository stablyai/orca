import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const CONNECTION = 'conn-1'
const T0 = 1_800_000_000_000

function ingest(
  server: AgentHookServer,
  payload: Record<string, unknown>,
  options: { isReplay?: boolean } = {}
): void {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(payload),
    'production'
  )
  if (!event) {
    throw new Error('normalizeHookPayload rejected a known-good Claude fixture')
  }
  server.ingestRemote({ ...event, ...(options.isReplay ? { isReplay: true } : {}) }, CONNECTION)
}

describe('the observation clock a relay replay must not restamp', () => {
  let server: AgentHookServer
  let emitted: EnrichedAgentHookEventPayload[]

  beforeEach(() => {
    _internals.resetCachesForTests()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    server = new AgentHookServer()
    emitted = []
    server.setListener((payload) => {
      emitted.push(payload)
    })
  })

  afterEach(() => {
    server.setListener(null)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const lastForPane = (): EnrichedAgentHookEventPayload =>
    emitted.toReversed().find((event) => event.paneKey === PANE)!

  it('holds the observation time across a reconnect replay while delivery order advances', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    expect(lastForPane().evidenceObservedAt).toBe(T0)

    vi.setSystemTime(T0 + 25 * 60 * 1000)
    // A lost transport clears the row; the age of the evidence it restates is not a claim.
    server.clearStatusEntriesForConnection(CONNECTION)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { isReplay: true }
    )

    const replayed = lastForPane()
    expect(replayed.payload.state).toBe('working')
    // Delivery order must still clear the connection watermark, or the renderer drops the row.
    expect(replayed.receivedAt).toBeGreaterThan(T0 + 25 * 60 * 1000 - 1)
    expect(replayed.evidenceObservedAt).toBe(T0)
  })

  it('lets a live event restamp the observation time after a replay', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    vi.setSystemTime(T0 + 25 * 60 * 1000)
    server.clearStatusEntriesForConnection(CONNECTION)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { isReplay: true }
    )

    vi.setSystemTime(T0 + 26 * 60 * 1000)
    ingest(server, { hook_event_name: 'PreToolUse', tool_name: 'Edit' })
    expect(lastForPane().evidenceObservedAt).toBe(T0 + 26 * 60 * 1000)
  })

  it('gives a torn-down pane no inherited observation time', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    server.clearPaneState(PANE)

    vi.setSystemTime(T0 + 25 * 60 * 1000)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'a new session' },
      { isReplay: true }
    )
    expect(lastForPane().evidenceObservedAt).toBe(T0 + 25 * 60 * 1000)
  })
})
