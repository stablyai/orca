// A user's stop is the turn's verdict. A provider error that lands after it (the aborted request
// failing on its way out) ends the same turn, so the row must keep reading Interrupted, never
// Failed. Only the store can hold that for lanes whose listener never learns of the cancel Orca
// inferred from the keystroke: relayed Claude, Grok and OpenCode.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

type Post = (payload: Record<string, unknown>) => Promise<void>

async function startLocal(agentPath: string): Promise<{ desktop: AgentHookServer; post: Post }> {
  const desktop = new AgentHookServer()
  running.push(desktop)
  await desktop.start({ env: 'production' })
  return {
    desktop,
    post: async (payload) => {
      const response = await postHookEvent(desktop, buildBody(payload), agentPath)
      expect(response.status).toBe(204)
    }
  }
}

async function startRelayedClaude(): Promise<{ desktop: AgentHookServer; post: Post }> {
  const desktop = new AgentHookServer()
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-cancel-failure-'))
  temporaryPaths.push(endpointDir)
  const relay = new RelayAgentHookServer({
    endpointDir,
    token: 'cancel-failure-token',
    forward: (envelope) => desktop.ingestRemote(envelope, 'conn-1')
  })
  running.push(relay, desktop)
  await relay.start({ publishEndpoint: false })
  return {
    desktop,
    post: async (payload) => {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
}

async function postAll(post: Post, payloads: Record<string, unknown>[]): Promise<void> {
  for (const payload of payloads) {
    await post(payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function pressCtrlC(server: AgentHookServer, agentType: string): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: agentType,
    ...(baseline.mainAgent
      ? { baselineMainAgentStateStartedAt: baseline.mainAgent.stateStartedAt }
      : {}),
    intent: 'ctrl-c'
  })
}

type Lane = {
  name: string
  agentType: string
  start: () => Promise<{ desktop: AgentHookServer; post: Post }>
  /** The events that submit a prompt and start its turn. */
  prompt: (text: string) => Record<string, unknown>[]
  failure: Record<string, unknown>
  plainSettle: Record<string, unknown>
}

const claudeLaneEvents = {
  agentType: 'claude',
  prompt: (text: string) => [{ hook_event_name: 'UserPromptSubmit', prompt: text }],
  failure: { hook_event_name: 'StopFailure', error: 'rate_limit' },
  plainSettle: { hook_event_name: 'Stop' }
}

const relayedClaude: Lane = {
  name: 'relayed Claude',
  start: startRelayedClaude,
  ...claudeLaneEvents
}

const grok: Lane = {
  name: 'Grok',
  agentType: 'grok',
  start: () => startLocal('/hook/grok'),
  prompt: (text) => [
    {
      sessionId: 'session-1',
      hookEventName: 'user_prompt_submit',
      promptId: `prompt-${text}`,
      prompt: text
    }
  ],
  failure: {
    sessionId: 'session-1',
    hookEventName: 'stop_failure',
    stopHookActive: false,
    error: { kind: 'server_error' }
  },
  plainSettle: {
    sessionId: 'session-1',
    hookEventName: 'stop',
    reason: 'end_turn',
    stopHookActive: false
  }
}

const openCode: Lane = {
  name: 'OpenCode',
  agentType: 'opencode',
  start: () => startLocal('/hook/opencode'),
  prompt: (text) => [
    { hook_event_name: 'MessagePart', role: 'user', text, root_state: 'working' },
    { hook_event_name: 'SessionBusy', root_state: 'working' }
  ],
  failure: { hook_event_name: 'SessionIdle', root_state: 'done', root_turn_error_name: 'APIError' },
  plainSettle: { hook_event_name: 'SessionIdle', root_state: 'done' }
}

describe.each([relayedClaude, grok, openCode])(
  'a same-turn failure after an inferred cancel ($name)',
  (lane) => {
    it('keeps the cancellation, the interrupted flag, and no turn-completion stamp', async () => {
      const { desktop, post } = await lane.start()
      await postAll(post, lane.prompt('long task'))
      expect(row(desktop).state).toBe('working')
      expect(pressCtrlC(desktop, lane.agentType)).toBe(true)
      expect(row(desktop).mainAgent).toMatchObject({
        state: 'done',
        outcome: 'cancellation'
      })

      await post(lane.failure)

      const settled = row(desktop)
      expect(settled).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(settled.turnCompletedAt).toBeUndefined()
    })

    it('lets a failure through once a new prompt opened another turn', async () => {
      const { desktop, post } = await lane.start()
      await postAll(post, lane.prompt('first'))
      expect(pressCtrlC(desktop, lane.agentType)).toBe(true)
      await postAll(post, lane.prompt('second'))
      await post(lane.failure)
      expect(row(desktop).mainAgent).toMatchObject({ state: 'done', outcome: 'failure' })
    })

    it("still releases on the provider's own plain settle", async () => {
      const { desktop, post } = await lane.start()
      await postAll(post, lane.prompt('long task'))
      expect(pressCtrlC(desktop, lane.agentType)).toBe(true)
      await post(lane.plainSettle)
      expect(row(desktop).state).toBe('done')
      expect(row(desktop).mainAgent?.outcome).toBeUndefined()
    })
  }
)

// Local Claude's listener learns of the inferred cancel and carries it into StopFailure itself, so
// this lane agrees with the store rule without needing it.
describe('local Claude listener carry', () => {
  it('reads a StopFailure after an inferred cancel as the cancellation', async () => {
    const { desktop, post } = await startLocal('/hook/claude')
    await postAll(post, claudeLaneEvents.prompt('long task'))
    expect(pressCtrlC(desktop, 'claude')).toBe(true)
    await post(claudeLaneEvents.failure)
    expect(row(desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})
