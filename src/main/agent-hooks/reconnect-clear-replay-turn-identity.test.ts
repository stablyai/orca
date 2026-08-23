import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const CONNECTION = 'ssh-host-1'
const T0 = 1_700_000_000_000
const PROMPT = 'ship the release notes'

function ingest(
  server: AgentHookServer,
  options: {
    state: 'working' | 'done'
    hookEventName: string
    isReplay?: boolean
    connectionId?: string
    prompt?: string
  }
): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: options.hookEventName,
      ...(options.isReplay ? { isReplay: true } : {}),
      payload: { state: options.state, prompt: options.prompt ?? PROMPT, agentType: 'claude' }
    },
    options.connectionId ?? CONNECTION
  )
}

function paneRow(server: AgentHookServer): {
  state: string
  receivedAt: number
  startedAt: number
} {
  const row = server.getStatusSnapshot()[0]
  if (!row) {
    throw new Error('expected a cached status row')
  }
  return { state: row.state, receivedAt: row.receivedAt, startedAt: row.stateStartedAt }
}

/** Completion-notification dedupe keys on `state:agentType:stateStartedAt`
 *  (agent-completion-coordinator.ts). Mirror that key so these assertions are about the
 *  thing the renderer actually compares, not an incidental field. */
function turnIdentity(server: AgentHookServer): string {
  const row = server.getStatusSnapshot()[0]
  if (!row) {
    throw new Error('expected a cached status row')
  }
  return [row.state, row.agentType ?? '', String(row.stateStartedAt)].join(':')
}

function completeATurn(server: AgentHookServer): void {
  ingest(server, { state: 'working', hookEventName: 'UserPromptSubmit' })
  vi.setSystemTime(T0 + 5_000)
  ingest(server, { state: 'done', hookEventName: 'Stop' })
}

describe('reconnect clear + replay keeps one completion turn identity (STA-3524)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reclaims the cleared turn identity when the reconnect replays that same turn', () => {
    const server = new AgentHookServer()
    completeATurn(server)
    const beforeDisconnect = paneRow(server)
    const notifiedIdentity = turnIdentity(server)

    // A dropped SSH connection clears every row it owned; reconnect replays the host cache.
    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    expect(server.getStatusSnapshot()).toEqual([])

    vi.setSystemTime(T0 + 61_000)
    ingest(server, { state: 'done', hookEventName: 'Stop', isReplay: true })

    expect(turnIdentity(server)).toBe(notifiedIdentity)
    expect(paneRow(server).startedAt).toBe(beforeDisconnect.startedAt)
    // receivedAt must still advance past the clear watermark or the renderer drops the row.
    expect(paneRow(server).receivedAt).toBeGreaterThan(beforeDisconnect.receivedAt)
  })

  it('mints a new turn identity for a completion that landed while disconnected', () => {
    const server = new AgentHookServer()
    ingest(server, { state: 'working', hookEventName: 'UserPromptSubmit' })
    const workingIdentity = turnIdentity(server)

    // The turn ended on the host while the relay was down, so this `done` is news.
    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    vi.setSystemTime(T0 + 61_000)
    ingest(server, { state: 'done', hookEventName: 'Stop', isReplay: true })

    expect(turnIdentity(server)).not.toBe(workingIdentity)
    expect(paneRow(server).startedAt).toBe(T0 + 61_000)
  })

  it('mints a new turn identity when the replay carries a different prompt', () => {
    const server = new AgentHookServer()
    completeATurn(server)
    const firstTurnStartedAt = paneRow(server).startedAt

    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    vi.setSystemTime(T0 + 61_000)
    ingest(server, {
      state: 'done',
      hookEventName: 'Stop',
      isReplay: true,
      prompt: 'a different task the host finished meanwhile'
    })

    expect(paneRow(server).startedAt).toBe(T0 + 61_000)
    expect(paneRow(server).startedAt).not.toBe(firstTurnStartedAt)
  })

  it('does not let another host reclaim the cleared turn', () => {
    const server = new AgentHookServer()
    completeATurn(server)

    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    vi.setSystemTime(T0 + 61_000)
    ingest(server, {
      state: 'done',
      hookEventName: 'Stop',
      isReplay: true,
      connectionId: 'ssh-host-2'
    })

    expect(paneRow(server).startedAt).toBe(T0 + 61_000)
  })

  it('does not reclaim the cleared turn for a live (non-replay) event', () => {
    const server = new AgentHookServer()
    completeATurn(server)
    const firstTurnStartedAt = paneRow(server).startedAt

    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    vi.setSystemTime(T0 + 61_000)
    ingest(server, { state: 'done', hookEventName: 'Stop' })

    expect(paneRow(server).startedAt).toBe(T0 + 61_000)
    expect(paneRow(server).startedAt).not.toBe(firstTurnStartedAt)
  })

  it('does not bleed the cleared turn into a genuinely new turn after the clear', () => {
    const server = new AgentHookServer()
    completeATurn(server)
    const firstTurnStartedAt = paneRow(server).startedAt

    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)

    // A live prompt lands first; the stale timing is spent and must not reach the next done.
    vi.setSystemTime(T0 + 61_000)
    ingest(server, { state: 'working', hookEventName: 'UserPromptSubmit' })
    vi.setSystemTime(T0 + 62_000)
    ingest(server, { state: 'done', hookEventName: 'Stop' })

    expect(paneRow(server).startedAt).toBe(T0 + 62_000)
    expect(paneRow(server).startedAt).not.toBe(firstTurnStartedAt)
  })

  it('does not reclaim a turn across a real pane teardown', () => {
    const server = new AgentHookServer()
    completeATurn(server)
    const firstTurnStartedAt = paneRow(server).startedAt

    vi.setSystemTime(T0 + 60_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.clearPaneState(PANE)

    vi.setSystemTime(T0 + 61_000)
    ingest(server, { state: 'done', hookEventName: 'Stop', isReplay: true })

    expect(paneRow(server).startedAt).toBe(T0 + 61_000)
    expect(paneRow(server).startedAt).not.toBe(firstTurnStartedAt)
  })
})
