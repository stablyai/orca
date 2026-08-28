import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { seedClaudeSubagentRosterFromSnapshots } from '../../shared/agent-hook-listener/providers/claude-roster-state'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const PANE_KEY = makePaneKey('manual-compact', '11111111-1111-4111-8111-111111111111')
const COMPACT_PROMPT_ID = '22222222-2222-4222-8222-222222222222'
const TURN_PROMPT_ID = '33333333-3333-4333-8333-333333333333'
const SESSION = { key: 'session_id' as const, id: 'session-a' }

function claudeHook(hookEventName: string, promptId: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: hookEventName,
    prompt_id: promptId,
    session_id: 'session-a',
    ...extra
  }
}

function postHook(port: number, token: string, payload: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
    body: JSON.stringify({ paneKey: PANE_KEY, payload })
  })
}

function turnEnvelope(): AgentHookRelayEnvelope {
  return {
    source: 'claude',
    paneKey: PANE_KEY,
    connectionId: null,
    hasExplicitPrompt: true,
    hookEventName: 'UserPromptSubmit',
    providerPromptId: TURN_PROMPT_ID,
    providerSession: SESSION,
    payload: { state: 'working', prompt: 'work before compact', agentType: 'claude' }
  } as AgentHookRelayEnvelope
}

/** What a relay predating this change forwards: it ran its own shipped normalizer, so a manual
 *  compact arrives as a PLAIN `done` (no session boundary) and an auto compact as `working`. */
function legacyRelayCompactEnvelope(
  state: 'done' | 'working',
  overrides: Partial<AgentHookRelayEnvelope> = {}
): AgentHookRelayEnvelope {
  return {
    source: 'claude',
    paneKey: PANE_KEY,
    connectionId: null,
    hookEventName: 'PostCompact',
    providerPromptId: COMPACT_PROMPT_ID,
    compactTrigger: state === 'done' ? 'manual' : 'auto',
    providerSession: SESSION,
    payload: { state, prompt: 'work before compact', agentType: 'claude' },
    ...overrides
  } as AgentHookRelayEnvelope
}

/** What AgentHookServer.hydrate() rebuilds for a pane that was stuck `working` across a restart:
 *  the previous session's connectionId, the unconfirmed flag, an older receivedAt, and the child
 *  the turn had spawned — restored from disk, so proof of nothing. */
function seedHydratedStuckPane(server: AgentHookServer, receivedAt: number) {
  const state = server._getStateForTests()
  const subagents = [{ id: 'child-1', state: 'working', startedAt: 0, agentType: 'general' }]
  state.lastStatusByPaneKey.set(PANE_KEY, {
    paneKey: PANE_KEY,
    source: 'claude',
    connectionId: null,
    hookEventName: 'UserPromptSubmit',
    providerPromptId: TURN_PROMPT_ID,
    providerSession: SESSION,
    restoredUnconfirmed: true,
    receivedAt,
    payload: { state: 'working', prompt: 'work before the restart', agentType: 'claude', subagents }
  } as never)
  seedClaudeSubagentRosterFromSnapshots(state, PANE_KEY, subagents as never)
}

describe('manual Claude compact hook stream', () => {
  const servers: { stop: () => void }[] = []
  const temporaryPaths: string[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop()
    }
    for (const path of temporaryPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('settles the measured local lifecycle and rejects a duplicate completion', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const port = Number(env.ORCA_AGENT_HOOK_PORT)
    const token = env.ORCA_AGENT_HOOK_TOKEN
    const events: string[] = []
    const unsubscribe = server.subscribeEnrichedStatus((event) => {
      events.push(`${event.hookEventName}:${event.payload.state}`)
    })

    await postHook(port, token, claudeHook('UserPromptSubmit', TURN_PROMPT_ID, { prompt: 'work' }))
    // Measured stream for a successful manual /compact. PreCompact is not registered in production
    // and is rejected here too; the summarizer's start-less SubagentStop only republishes state.
    await postHook(port, token, claudeHook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    await postHook(
      port,
      token,
      claudeHook('SubagentStop', COMPACT_PROMPT_ID, {
        agent_id: 'a75b38b59774e1f31',
        agent_type: '',
        background_tasks: [],
        session_crons: []
      })
    )
    await postHook(
      port,
      token,
      claudeHook('SessionStart', COMPACT_PROMPT_ID, { source: 'compact' })
    )
    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    expect(events).toEqual(['UserPromptSubmit:working', 'SubagentStop:working', 'PostCompact:done'])
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'done', prompt: 'work', agentType: 'claude' })
    ])
    unsubscribe()
  })

  it('clears the restart-stuck pane STA-2915 reports, without resurrecting anything', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const port = Number(env.ORCA_AGENT_HOOK_PORT)
    const token = env.ORCA_AGENT_HOOK_TOKEN!
    seedHydratedStuckPane(server, Date.now() - 60_000)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })

    await postHook(port, token, claudeHook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    await postHook(
      port,
      token,
      claudeHook('SubagentStop', COMPACT_PROMPT_ID, {
        agent_id: 'a75b38b59774e1f31',
        agent_type: ''
      })
    )
    await postHook(
      port,
      token,
      claudeHook('SessionStart', COMPACT_PROMPT_ID, { source: 'compact' })
    )
    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    const row = server.getStatusSnapshot()[0]
    expect(row).toMatchObject({ state: 'done', prompt: 'work before the restart' })
    expect(row?.subagents ?? []).toEqual([])
  })

  it('does not restate a pane a live child still owns, so the staleness clock keeps running', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const port = Number(env.ORCA_AGENT_HOOK_PORT)
    const token = env.ORCA_AGENT_HOOK_TOKEN!
    seedHydratedStuckPane(server, Date.now() - 60_000)
    // A child THIS runtime observed: real agent work in flight, which a compact may not retire.
    await postHook(
      port,
      token,
      claudeHook('SubagentStart', TURN_PROMPT_ID, { agent_id: 'child-live' })
    )
    const before = server.getStatusSnapshot()[0]
    expect(before).toMatchObject({ state: 'working' })

    const emitted: string[] = []
    const unsubscribe = server.subscribeEnrichedStatus((event) => {
      emitted.push(`${event.hookEventName}:${event.payload.state}`)
    })
    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    // Why: restating the row here is the regression, not the fix — it would refresh receivedAt and
    // hand the stale sweep a brand-new clock for work the compact never observed.
    expect(emitted).toEqual([])
    expect(server.getStatusSnapshot()[0]).toEqual(before)
    unsubscribe()
  })

  it('forwards the completion over the relay and preserves its cached compact identity', async () => {
    const main = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const emitted: string[] = []
    const endpointDir = mkdtempSync(join(tmpdir(), 'orca-compact-relay-'))
    temporaryPaths.push(endpointDir)
    const relay = new RelayAgentHookServer({
      endpointDir,
      token: 'manual-compact-token',
      forward: (envelope) => {
        forwarded.push(envelope)
        main.ingestRemote(envelope, 'conn-a')
      }
    })
    servers.push(main, relay)
    const unsubscribe = main.subscribeEnrichedStatus((event) => {
      emitted.push(`${event.hookEventName}:${event.payload.state}`)
    })
    await relay.start({ publishEndpoint: false })
    const { port, token } = relay.getCoordinates()

    await postHook(port, token, claudeHook('UserPromptSubmit', TURN_PROMPT_ID, { prompt: 'work' }))
    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    expect(forwarded.at(-1)).toMatchObject({
      source: 'claude',
      hookEventName: 'PostCompact',
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID
    })
    expect(emitted.at(-1)).toBe('PostCompact:done')
    expect(main.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })

    // Why: a client that was offline during the compact receives the row as a reconnect replay of
    // this cache. Retaining the compact identity lets the client re-run ownership instead of
    // treating an unowned completion as an ordinary status row.
    const replayed = relay.replayCachedPayloadsForPanes()
    expect(replayed).toBeGreaterThan(0)
    expect(forwarded.at(-1)).toMatchObject({ isReplay: true, payload: { state: 'done' } })
    expect(forwarded.at(-1)).toMatchObject({
      hookEventName: 'PostCompact',
      compactTrigger: 'manual'
    })
    unsubscribe()
  })

  it('forwards the completion from a relay whose cache is cold, and the client still guards it', async () => {
    const main = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const endpointDir = mkdtempSync(join(tmpdir(), 'orca-compact-cold-'))
    temporaryPaths.push(endpointDir)
    // A relay that restarted while the agent session kept running: hooks resolve the endpoint file
    // per invocation, so they reconnect — but the relay's per-process cache is empty, and the
    // compact completion may be the first event it ever sees for this pane.
    const relay = new RelayAgentHookServer({
      endpointDir,
      token: 'cold-cache-token',
      forward: (envelope) => {
        forwarded.push(envelope)
        main.ingestRemote(envelope, 'conn-a')
      }
    })
    servers.push(main, relay)
    await relay.start({ publishEndpoint: false })
    const { port, token } = relay.getCoordinates()

    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    // Why: the relay is a forwarder, not the authority on pane identity. Dropping the event here
    // is how the one signal that can clear a remote pane goes missing after a restart.
    expect(forwarded.map((envelope) => envelope.hookEventName)).toEqual(['PostCompact'])
    expect(forwarded[0]).toMatchObject({
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID
    })
    // ...and the client, which DOES own pane identity, still refuses to mint a row it never had.
    expect(main.getStatusSnapshot()).toEqual([])
  })

  it('does not resurrect a retired pane when the cold relay replays its completion', async () => {
    const main = new AgentHookServer()
    const endpointDir = mkdtempSync(join(tmpdir(), 'orca-compact-cold-replay-'))
    temporaryPaths.push(endpointDir)
    const relay = new RelayAgentHookServer({
      endpointDir,
      token: 'cold-replay-token',
      forward: (envelope) => main.ingestRemote(envelope, 'conn-a')
    })
    servers.push(main, relay)
    await relay.start({ publishEndpoint: false })
    const { port, token } = relay.getCoordinates()

    await postHook(port, token, claudeHook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    expect(main.getStatusSnapshot()).toEqual([])

    expect(relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(main.getStatusSnapshot()).toEqual([])
  })

  it('stamps the silent boundary on a manual completion from a relay that predates it', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(turnEnvelope(), 'conn-a')
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })

    server.ingestRemote(legacyRelayCompactEnvelope('done'), 'conn-a')

    // Why: the old relay built this payload before the flag existed, so it arrives as a plain
    // `done` that every completion-reactive consumer would read as a finished turn.
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })
  })

  it('drops an auto compact from a relay that predates it, instead of minting working', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(turnEnvelope(), 'conn-a')
    server.ingestRemote(
      {
        ...turnEnvelope(),
        payload: { state: 'done', prompt: 'work', agentType: 'claude' },
        hookEventName: 'Stop'
      } as AgentHookRelayEnvelope,
      'conn-a'
    )
    const before = server.getStatusSnapshot()[0]
    expect(before).toMatchObject({ state: 'done' })

    server.ingestRemote(legacyRelayCompactEnvelope('working'), 'conn-a')

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  })

  it('suppresses a duplicate completion arriving twice over the relay', () => {
    const server = new AgentHookServer()
    servers.push(server)
    const emitted: string[] = []
    const unsubscribe = server.subscribeEnrichedStatus((event) => {
      emitted.push(`${event.hookEventName}:${event.payload.state}`)
    })
    server.ingestRemote(turnEnvelope(), 'conn-a')
    server.ingestRemote(legacyRelayCompactEnvelope('done'), 'conn-a')
    const applied = server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)
    expect(applied?.payload.state).toBe('done')

    server.ingestRemote(legacyRelayCompactEnvelope('done'), 'conn-a')

    // Why: the deleted ownership cache used to reject a repeat; a same-owner guard alone would
    // accept it and keep refreshing the row, so suppression is keyed on the consumed compact id.
    expect(emitted).toEqual(['UserPromptSubmit:working', 'PostCompact:done'])
    expect(server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)).toBe(applied)
    unsubscribe()
  })

  it('classifies a triggerless replay by payload state and still checks ownership', () => {
    const done = new AgentHookServer()
    servers.push(done)
    done.ingestRemote(turnEnvelope(), 'conn-a')
    // An older relay strips compactTrigger from its cached PostCompact before replaying it.
    done.ingestRemote(
      legacyRelayCompactEnvelope('done', { compactTrigger: undefined, isReplay: true }),
      'conn-a'
    )
    expect(done.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })

    // Why: assert this arm from a pane that already FINISHED. Asserting `working` on a pane that
    // was already `working` cannot fail — it holds whether the replay was dropped or applied, which
    // is exactly how a trigger-stripped auto compact could start re-arming the stuck row again.
    const working = new AgentHookServer()
    servers.push(working)
    working.ingestRemote(turnEnvelope(), 'conn-a')
    working.ingestRemote(
      {
        ...turnEnvelope(),
        hookEventName: 'Stop',
        payload: { state: 'done', prompt: 'work before compact', agentType: 'claude' }
      } as AgentHookRelayEnvelope,
      'conn-a'
    )
    expect(working.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    working.ingestRemote(
      legacyRelayCompactEnvelope('working', { compactTrigger: undefined, isReplay: true }),
      'conn-a'
    )
    expect(working.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })

    const foreign = new AgentHookServer()
    servers.push(foreign)
    foreign.ingestRemote(turnEnvelope(), 'conn-a')
    // Payload state substitutes for the missing trigger only — ownership is still enforced.
    foreign.ingestRemote(
      legacyRelayCompactEnvelope('done', {
        compactTrigger: undefined,
        isReplay: true,
        providerSession: { key: 'session_id', id: 'a-different-session' }
      }),
      'conn-a'
    )
    expect(foreign.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
  })

  it('keeps the summarized turn as the label, with or without a trigger on the envelope', () => {
    // The compact's own event carries no prompt of its own, so the row's label can only come from
    // the turn it summarized. The trigger-stripped replay is the one shape that arrives with no
    // trigger at all, so the carry-forward must not be keyed on the trigger being present.
    const blank = { state: 'done' as const, prompt: '', agentType: 'claude' }

    const tagged = new AgentHookServer()
    servers.push(tagged)
    tagged.ingestRemote(turnEnvelope(), 'conn-a')
    tagged.ingestRemote(legacyRelayCompactEnvelope('done', { payload: blank }), 'conn-a')
    expect(tagged.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      prompt: 'work before compact'
    })

    const stripped = new AgentHookServer()
    servers.push(stripped)
    stripped.ingestRemote(turnEnvelope(), 'conn-a')
    stripped.ingestRemote(
      legacyRelayCompactEnvelope('done', {
        compactTrigger: undefined,
        isReplay: true,
        payload: blank
      }),
      'conn-a'
    )
    expect(stripped.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      prompt: 'work before compact'
    })
  })

  it('rejects a completion with no provider prompt id', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(turnEnvelope(), 'conn-a')

    server.ingestRemote(
      legacyRelayCompactEnvelope('done', { providerPromptId: undefined }),
      'conn-a'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
  })

  it('never lets a PreCompact envelope drive pane state', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(turnEnvelope(), 'conn-a')
    server.ingestRemote(
      {
        ...turnEnvelope(),
        payload: { state: 'done', prompt: 'work', agentType: 'claude' },
        hookEventName: 'Stop'
      } as AgentHookRelayEnvelope,
      'conn-a'
    )

    server.ingestRemote(
      legacyRelayCompactEnvelope('working', {
        hookEventName: 'PreCompact',
        compactTrigger: 'manual'
      }),
      'conn-a'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  })
})
