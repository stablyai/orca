import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusObservation } from '../../shared/agent-status-observation'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const CONNECTION = 'ssh-provenance'

type Observed = { paneKey: string; observation?: AgentStatusObservation }

function collectObservations(server: AgentHookServer): Observed[] {
  const seen: Observed[] = []
  server.setListener((payload) => {
    seen.push({ paneKey: payload.paneKey, observation: payload.observation })
  })
  return seen
}

function lastObservation(seen: Observed[]): AgentStatusObservation {
  const observation = seen.at(-1)?.observation
  if (!observation) {
    throw new Error('expected the last emitted status to carry an observation')
  }
  return observation
}

describe('agent status observation provenance', () => {
  const servers: AgentHookServer[] = []

  beforeEach(() => {
    _internals.resetCachesForTests()
    getCohortAtEmitMock.mockReturnValue({})
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    vi.restoreAllMocks()
  })

  function newServer(): AgentHookServer {
    const server = new AgentHookServer()
    servers.push(server)
    return server
  }

  it('stamps relayed hook events as hook-origin transitions', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'claude',
        hookEventName: 'PostToolUse',
        payload: { state: 'working', prompt: 'relayed', agentType: 'claude' }
      },
      CONNECTION
    )

    expect(lastObservation(seen)).toMatchObject({
      origin: 'hook',
      kind: 'transition',
      authorityId: expect.stringMatching(/^main-agent-hooks:/),
      observedAt: expect.any(Number)
    })
    expect(lastObservation(seen).boundary).toBeUndefined()
  })

  it('stamps main-parsed OSC 9999 rows as osc-origin snapshots', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      payload: { state: 'working', prompt: 'from bytes', agentType: 'codex' }
    })

    expect(lastObservation(seen)).toMatchObject({ origin: 'osc', kind: 'snapshot' })
  })

  it('stamps a relay replay as a snapshot, not a fresh transition', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        isReplay: true,
        payload: { state: 'working', prompt: 'replayed', agentType: 'claude' }
      },
      CONNECTION
    )

    expect(lastObservation(seen).kind).toBe('snapshot')
  })

  it('marks a resume-identity refresh as identity-only rather than a turn transition', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'pi',
        hookEventName: 'before_agent_start',
        providerSessionOnly: true,
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/tmp/pi-session-1.json'
        },
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      CONNECTION
    )

    expect(lastObservation(seen).kind).toBe('identity-only')
  })

  // Why: this is the whole point of stamping boundary from the listener's own classifier.
  // `before_agent_start`, `BeforeAgent` and `agent.start` are NOT the two raw literals the
  // retired-pane gate matches, so a second hand-written list here would report them as
  // non-boundaries — exactly the defect PR #14626 fixed one instance of.
  it.each([
    { source: 'claude', hookEventName: 'UserPromptSubmit', agentType: 'claude' },
    { source: 'pi', hookEventName: 'before_agent_start', agentType: 'pi' },
    { source: 'gemini', hookEventName: 'BeforeAgent', agentType: 'gemini' },
    { source: 'amp', hookEventName: 'agent.start', agentType: 'amp' },
    { source: 'cursor', hookEventName: 'beforeSubmitPrompt', agentType: 'cursor' }
  ])(
    'stamps boundary for $source $hookEventName even though it is not a gate literal',
    ({ source, hookEventName, agentType }) => {
      const server = newServer()
      const seen = collectObservations(server)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          source,
          hookEventName,
          payload: { state: 'working', prompt: 'a new turn', agentType }
        },
        CONNECTION
      )

      expect(lastObservation(seen).boundary).toBe(true)
    }
  )

  it('does not stamp boundary for a mid-turn event of a boundary-capable provider', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'gemini',
        hookEventName: 'PostToolUse',
        payload: { state: 'working', prompt: 'mid turn', agentType: 'gemini' }
      },
      CONNECTION
    )

    expect(lastObservation(seen).boundary).toBeUndefined()
  })

  it('advances revision per accepted observation and bumps incarnation when a retired pane restarts', () => {
    const server = newServer()
    const seen = collectObservations(server)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'first turn', agentType: 'claude' }
      },
      CONNECTION
    )
    const first = lastObservation(seen)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'claude',
        hookEventName: 'Stop',
        payload: { state: 'done', prompt: 'first turn', agentType: 'claude' }
      },
      CONNECTION
    )
    const second = lastObservation(seen)

    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.incarnation).toBe(first.incarnation)

    server.retirePaneAuthority(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'reused pane', agentType: 'claude' }
      },
      CONNECTION
    )
    const restarted = lastObservation(seen)

    expect(restarted.incarnation).toBeGreaterThan(second.incarnation)
    expect(restarted.revision).toBeGreaterThan(second.revision)
  })

  it('never persists the observation to last-status.json', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-observation-'))
    try {
      const server = newServer()
      await server.start({ env: 'production', userDataPath })
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'claude',
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'persist me', agentType: 'claude' }
        },
        CONNECTION
      )
      server.flushStatusPersistSync()

      const path = join(userDataPath, 'agent-hooks', 'last-status.json')
      expect(existsSync(path)).toBe(true)
      const file = readFileSync(path, 'utf8')
      // Why: the sequencer that issued it dies with the process, so a stored copy could only
      // rehydrate as an ordering claim from a dead authority.
      expect(file).not.toContain('observation')
      expect(JSON.parse(file).entries[PANE].observation).toBeUndefined()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
