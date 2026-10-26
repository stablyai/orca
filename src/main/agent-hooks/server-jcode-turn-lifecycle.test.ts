import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBody, GOOD_PANE, PANE } from './server.test-fixtures'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { normalizeHookPayload, prepareJcodeHookPayload } from '../../shared/agent-hook-listener'
import { bindJcodeRootSession } from '../../shared/agent-hook-listener/jcode-session-registry'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  clearPaneTurnCacheState,
  createHookListenerState,
  deleteLegacyAgentStatus,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import { cacheRelayLegacyAgentStatus } from '../../shared/agent-status-legacy-relay-cache'
import { settleJcodeRootTurn } from '../../shared/agent-hook-listener/providers/jcode-events'
import { seedJcodeStateFromSnapshot } from '../../shared/agent-hook-listener/providers/jcode-roster-state'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'

import {
  TURN_START,
  TOOL,
  TURN_END,
  SESSION_END,
  LATE_TOOL
} from './server-jcode-turn-lifecycle-fixtures'

class LifecycleServer extends AgentHookServer {
  acceptJcode(payload: Record<string, unknown>, overrides: Partial<AgentHookEventPayload> = {}) {
    const prepared = prepareJcodeHookPayload(
      this._getStateForTests(),
      buildBody(payload),
      'production'
    )
    if (!prepared?.event) {
      return null
    }
    const event = { ...prepared.event, ...overrides }
    const row = this.applyNormalizedStatus(
      event,
      undefined,
      'hook',
      undefined,
      undefined,
      false,
      prepared.commit
    )
    return row === this._getStateForTests().lastStatusByPaneKey.get(PANE) ? (row ?? null) : null
  }
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jcode-turn-lifecycle-'))
  mkdirSync(join(home, 'sessions'))
  vi.stubEnv('JCODE_HOME', home)
  for (const id of [TURN_START.session_id, 'root', 'replacement', 'worker', 'different-session']) {
    writeFileSync(join(home, 'sessions', `${id}.json`), JSON.stringify({ id, parent_id: null }))
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function cacheSnapshot(state: HookListenerState) {
  return structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
}

describe.each([null, 'ssh-connection'])('Jcode turn lifecycle on host %s', (connectionId) => {
  let server: LifecycleServer
  let state: HookListenerState

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    server = new LifecycleServer()
    state = connectionId === null ? server._getStateForTests() : createHookListenerState()
  })

  afterEach(() => {
    server.stop()
    clearAllListenerCaches(state)
    vi.useRealTimers()
  })

  function send(payload: Record<string, unknown>) {
    if (connectionId === null) {
      return server.acceptJcode(payload)
    }
    const prepared = prepareJcodeHookPayload(state, buildBody(payload), 'production')
    const event = prepared?.event ?? null
    if (event) {
      if (connectionId !== null) {
        if (
          cacheRelayLegacyAgentStatus(state, event, 16, (paneKey) =>
            clearPaneCacheState(state, paneKey)
          )
        ) {
          prepared?.commit()
        }
      }
      server.ingestRemote(event, connectionId)
    }
    return event
  }

  it('starts, reports the tool, ends, rejects late tools, and reopens the same session', () => {
    send(TURN_START)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      model: TURN_START.model
    })
    send(TOOL)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', toolName: 'write' })
    send(TURN_END)
    const baseline = server.getStatusSnapshot()
    expect(baseline[0]).toMatchObject({
      state: 'done',
      lastAssistantMessage: TURN_END.last_assistant_text
    })
    const caches = cacheSnapshot(state)
    for (const event of ['pre_tool', 'post_tool']) {
      expect(send({ ...LATE_TOOL, event })).toBeNull()
      expect(server.getStatusSnapshot()).toEqual(baseline)
      expect(cacheSnapshot(state)).toEqual(caches)
    }
    send(TURN_START)
    expect(send(TOOL)?.payload.state).toBe('working')
    expect(server.getStatusSnapshot()[0].lastAssistantMessage).toBeUndefined()
  })

  it('drops the captured tool 38.630 seconds after session_end', () => {
    send(TURN_START)
    send(TOOL)
    send(SESSION_END)
    const baseline = server.getStatusSnapshot()
    expect(baseline[0]).toMatchObject({
      state: 'done',
      model: TURN_START.model,
      providerSession: { key: 'session_id', id: TURN_START.session_id }
    })
    const caches = cacheSnapshot(state)
    // Ordering replay of the +38.630 s capture; admission is independent of elapsed time.
    expect(send(LATE_TOOL)).toBeNull()
    expect(server.getStatusSnapshot()).toEqual(baseline)
    expect(cacheSnapshot(state)).toEqual(caches)
  })

  it('leaves identity-only session_start idle until an admitted turn_start', () => {
    expect(send(LATE_TOOL)).toBeNull()
    expect(server.getStatusSnapshot()).toEqual([])
    send({ ...TURN_START, event: 'session_start', source: 'create' })
    const baseline = server.getStatusSnapshot()
    expect(send(LATE_TOOL)).toBeNull()
    expect(server.getStatusSnapshot()).toEqual(baseline)
    send(TURN_START)
    expect(send(TOOL)?.payload.state).toBe('working')
    send({ ...TURN_START, event: 'session_start', source: 'resume' })
    expect(state.jcodeTurnByPaneKey.get(PANE)?.active).toBe(true)
    expect(send(TOOL)?.payload.state).toBe('working')
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      model: TURN_START.model,
      providerSession: { id: TURN_START.session_id },
      toolName: 'write',
      mainAgent: { state: 'working' }
    })
  })

  it('drops other-session tools and end events without changing root identity or caches', () => {
    send(TURN_START)
    send(TOOL)
    const baseline = server.getStatusSnapshot()
    const caches = cacheSnapshot(state)
    for (const payload of [TOOL, TURN_END, SESSION_END]) {
      expect(
        send({ ...payload, session_id: 'different-session', prompt: 'wrong', model: 'wrong' })
      ).toBeNull()
      expect(server.getStatusSnapshot()).toEqual(baseline)
      expect(cacheSnapshot(state)).toEqual(caches)
    }
    expect(send(TOOL)?.payload.state).toBe('working')
  })

  it('settles only the matching root turn', () => {
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, 1)).toBeNull()
    send({ ...TURN_START, prompt: 'keep root prompt' })
    send({ ...TOOL, event: 'pre_tool' })
    send(TOOL)
    const baseline = server.getStatusSnapshot()[0]
    expect(baseline).toMatchObject({
      prompt: 'keep root prompt',
      model: TURN_START.model,
      toolName: 'write',
      toolInput: 'edit-me.txt'
    })
    const turn = state.jcodeTurnByPaneKey.get(PANE)
    expect(turn?.active).toBe(true)
    if (!turn) {
      throw new Error('missing admitted turn')
    }
    const revision = turn.revision
    expect(settleJcodeRootTurn(state, PANE, 'wrong', revision)).toBeNull()
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision + 1)).toBeNull()
    expect(state.jcodeTurnByPaneKey.get(PANE)?.active).toBe(true)
    const settled = settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision)
    expect(settled).toMatchObject({
      state: 'done',
      prompt: baseline.prompt,
      model: baseline.model,
      toolName: baseline.toolName,
      toolInput: baseline.toolInput
    })
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision)).toBeNull()
    expect(send(TOOL)).toBeNull()
    send(TURN_START)
    const next = state.jcodeTurnByPaneKey.get(PANE)
    expect(next?.revision).toBeGreaterThan(revision)
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision)).toBeNull()
    expect(send(TOOL)?.payload.state).toBe('working')
    send(TURN_START)
    expect(state.jcodeTurnByPaneKey.get(PANE)?.revision).toBeGreaterThan(next?.revision ?? 0)
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, next?.revision ?? 0)).toBeNull()
  })

  it('keeps the active root turn through worker lifecycle and tool events', () => {
    send({ ...TURN_START, session_id: 'root' })
    const baseline = server.getStatusSnapshot()
    const caches = cacheSnapshot(state)
    for (const event of [
      'session_start',
      'turn_start',
      'pre_tool',
      'post_tool',
      'turn_end',
      'session_end'
    ]) {
      expect(send({ ...TOOL, event, session_id: 'worker' })).toBeNull()
      expect(server.getStatusSnapshot()).toEqual(baseline)
      expect(cacheSnapshot(state)).toEqual(caches)
      expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({ sessionId: 'root', active: true })
      expect(server.getStatusSnapshot()[0].state).toBe('working')
    }
    expect(send({ ...TOOL, session_id: 'root' })?.payload).toMatchObject({
      state: 'working',
      toolName: 'write'
    })
    expect(send({ ...TURN_END, session_id: 'root' })?.payload.state).toBe('done')
    expect(server.getStatusSnapshot()[0].state).toBe('done')
    expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({ sessionId: 'root', active: false })
    bindJcodeRootSession(state, PANE, 'worker', 'launch')
    expect(send({ ...TURN_START, session_id: 'worker' })?.payload.state).toBe('working')
    expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({ sessionId: 'worker', active: true })
  })

  it('ignores another session before the active turn expires', () => {
    send({ ...TURN_START, session_id: 'root' })
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS - 1)
    const caches = cacheSnapshot(state)
    for (const event of ['session_start', 'turn_start']) {
      expect(send({ ...TURN_START, event, session_id: 'replacement' })).toBeNull()
      expect(cacheSnapshot(state)).toEqual(caches)
    }
  })

  it('admits another session when the active turn expires', () => {
    send({ ...TURN_START, session_id: 'root' })
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS)
    bindJcodeRootSession(state, PANE, 'replacement', 'launch')
    expect(send({ ...TURN_START, session_id: 'replacement' })?.payload.state).toBe('working')
    expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({
      sessionId: 'replacement',
      active: true,
      lastActivityAt: Date.now()
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      providerSession: { id: 'replacement' }
    })
  })

  it('keeps a long turn active while its own tool events refresh activity', () => {
    send({ ...TURN_START, session_id: 'root' })
    for (const event of ['pre_tool', 'post_tool', 'pre_tool', 'post_tool']) {
      vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS - 1)
      expect(send({ ...TOOL, event, session_id: 'root' })?.payload.state).toBe('working')
      expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({
        sessionId: 'root',
        active: true,
        lastActivityAt: Date.now()
      })
      expect(send({ ...TURN_START, session_id: 'replacement' })).toBeNull()
    }
  })

  it.each(['missing', 'other-agent', 'identity-only', 'other-session'])(
    'preserves admission when the accepted-row guard fails for %s',
    (rootCase) => {
      const start = send(TURN_START)
      if (!start) {
        throw new Error('missing normalized start')
      }
      if (rootCase === 'missing') {
        deleteLegacyAgentStatus(state, PANE)
      } else {
        seedLegacyAgentStatusForTests(state, {
          ...start,
          hostEvidenceObservedAt: Date.now(),
          providerSessionOnly: rootCase === 'identity-only',
          providerSession: {
            key: 'session_id',
            id: rootCase === 'other-session' ? 'other' : TURN_START.session_id
          },
          payload: { ...start.payload, agentType: rootCase === 'other-agent' ? 'claude' : 'jcode' }
        })
      }
      const caches = cacheSnapshot(state)
      expect(send(SESSION_END)).toBeNull()
      expect(state.jcodeTurnByPaneKey.get(PANE)?.active).toBe(true)
      expect(cacheSnapshot(state)).toEqual(caches)
      clearPaneCacheState(state, PANE)
      expect(state.jcodeSessions.bindings.size).toBe(0)
      expect(state.jcodeRootPayloadByPaneKey.size).toBe(0)
      expect(send(LATE_TOOL)).toBeNull()
    }
  )

  it.each([TURN_END, SESSION_END])('accepts orphan $event after a listener restart', (ending) => {
    const previous = normalizeHookPayload(
      createHookListenerState(),
      'jcode',
      buildBody(TURN_START),
      'production'
    )
    if (!previous) {
      throw new Error('missing previous host event')
    }
    if (connectionId !== null) {
      cacheRelayLegacyAgentStatus(state, previous, 16, (paneKey) =>
        clearPaneCacheState(state, paneKey)
      )
    }
    server.ingestRemote(previous, connectionId)
    expect(server.getStatusSnapshot()[0].state).toBe('working')
    if (connectionId === null) {
      // Main hydrates local snapshots; relay listeners have no snapshot seed.
      seedJcodeStateFromSnapshot(state, PANE, previous)
    }
    expect(state.jcodeTurnByPaneKey.has(PANE)).toBe(false)
    expect(send(ending)?.payload).toMatchObject({ state: 'done', model: ending.model })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      model: ending.model,
      providerSession: { key: 'session_id', id: ending.session_id }
    })
    if (ending.event === 'turn_end') {
      expect(server.getStatusSnapshot()[0].lastAssistantMessage).toBe(TURN_END.last_assistant_text)
    }
    expect(send(LATE_TOOL)).toBeNull()
  })

  it('preserves a live Claude root when orphan Jcode endings arrive', () => {
    const owner = {
      paneKey: PANE,
      connectionId: null,
      worktreeId: 'wt-1',
      source: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'claude-session' },
      hostEvidenceObservedAt: Date.now(),
      payload: { state: 'working' as const, prompt: 'keep Claude', agentType: 'claude' }
    }
    server.ingestRemote(owner, connectionId)
    if (connectionId !== null) {
      seedLegacyAgentStatusForTests(state, owner)
    }
    const snapshot = server.getStatusSnapshot()
    const caches = cacheSnapshot(state)
    for (const ending of [TURN_END, SESSION_END]) {
      expect(send(ending)).toBeNull()
      expect(server.getStatusSnapshot()).toEqual(snapshot)
      expect(cacheSnapshot(state)).toEqual(caches)
    }
  })

  it.each(['pane', 'turn', 'all'])('does not reuse a revision after %s cleanup', (cleanup) => {
    send(TURN_START)
    const revision = state.jcodeTurnByPaneKey.get(PANE)?.revision
    if (revision === undefined) {
      throw new Error('missing old revision')
    }
    if (cleanup === 'pane') {
      clearPaneCacheState(state, PANE)
    } else if (cleanup === 'turn') {
      clearPaneTurnCacheState(state, PANE)
    } else {
      clearAllListenerCaches(state)
    }
    send(TURN_START)
    expect(state.jcodeTurnByPaneKey.get(PANE)?.revision).toBeGreaterThan(revision)
    expect(settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision)).toBeNull()
    expect(send(TOOL)?.payload.state).toBe('working')
  })

  it.each(['cancel', 'session_end'])('clears waiting-only fields on %s settlement', (ending) => {
    send({ ...TURN_START, prompt: 'keep prompt' })
    send({
      event: 'pre_tool',
      session_id: TURN_START.session_id,
      tool_name: 'request_permission',
      tool_input: '{"action":"delete the staging bucket","reason":"Why this needs approval"}'
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'waiting',
      interactivePrompt: '{"action":"delete the staging bucket","reason":"Why this needs approval"}'
    })
    const revision = state.jcodeTurnByPaneKey.get(PANE)?.revision
    if (revision === undefined) {
      throw new Error('missing waiting turn revision')
    }
    const done =
      ending === 'cancel'
        ? settleJcodeRootTurn(state, PANE, TURN_START.session_id, revision)
        : send(SESSION_END)?.payload
    expect(done).toMatchObject({
      state: 'done',
      prompt: 'keep prompt',
      model: TURN_START.model,
      toolName: 'request_permission',
      toolInput: 'delete the staging bucket'
    })
    expect(done?.interactivePrompt).toBeUndefined()
    expect(done?.workingMode).toBeUndefined()
    expect(send(LATE_TOOL)).toBeNull()
  })
})

describe('Jcode execution-host title cancellation', () => {
  const WORK = '🌐 jcode/castle Skunk · +2 -1 · work ~10s'
  const LAST = '🌐 jcode/castle Skunk · +2 -1 · last ~10s'
  let server: LifecycleServer
  let state: HookListenerState

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    server = new LifecycleServer()
    state = server._getStateForTests()
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
  })

  function send(
    payload: Record<string, unknown> = TURN_START,
    overrides: Partial<AgentHookEventPayload> = {}
  ) {
    return server.acceptJcode(payload, overrides)
  }

  function arm() {
    server.observeJcodeTerminalTitle(PANE, WORK)
    server.observeJcodeTerminalTitle(PANE, LAST)
  }

  it('settles at 2,000 ms from the first last frame and rejects the late captured tool', () => {
    send({ ...TURN_START, prompt: 'Keep root prompt' })
    arm()
    vi.advanceTimersByTime(1_000)
    server.observeJcodeTerminalTitle(PANE, LAST)
    send(TOOL)
    vi.advanceTimersByTime(999)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    vi.advanceTimersByTime(1)
    const done = server.getStatusSnapshot()
    expect(done[0]).toMatchObject({
      state: 'done',
      prompt: 'Keep root prompt',
      model: TURN_START.model,
      providerSession: { key: 'session_id', id: TURN_START.session_id },
      toolName: 'write'
    })
    expect(done[0].lastAssistantMessage).toBeUndefined()
    expect(done[0].interrupted).toBeUndefined()
    expect(send(LATE_TOOL)).toBeNull()
    expect(server.getStatusSnapshot()).toEqual(done)
  })

  it('settles when wall time lags timer expiry by one millisecond', () => {
    send()
    const firstLastAt = Date.now()
    arm()
    vi.setSystemTime(firstLastAt - 1)
    vi.advanceTimersByTime(2_000)
    expect(Date.now() - firstLastAt).toBe(1_999)
    expect(server.getStatusSnapshot()[0].state).toBe('done')
  })

  it('lets the captured turn_end win during grace', () => {
    send()
    arm()
    vi.advanceTimersByTime(1_000)
    send(TURN_END)
    const normal = server.getStatusSnapshot()
    expect(normal[0]).toMatchObject({
      state: 'done',
      lastAssistantMessage: TURN_END.last_assistant_text
    })
    vi.advanceTimersByTime(1_000)
    expect(server.getStatusSnapshot()).toEqual(normal)
  })

  it.each(['same-turn-start', 'work', 'reset', 'shell', 'identity-only'])(
    'invalidates a pending edge on %s and requires fresh work',
    (replacement) => {
      send()
      arm()
      vi.advanceTimersByTime(1_000)
      if (replacement === 'same-turn-start') {
        send()
      } else {
        const title =
          replacement === 'work'
            ? WORK
            : replacement === 'reset'
              ? null
              : replacement === 'shell'
                ? 'bash'
                : '🦨 jcode/castle Skunk'
        server.observeJcodeTerminalTitle(PANE, title)
      }
      vi.advanceTimersByTime(1_000)
      expect(server.getStatusSnapshot()[0].state).toBe('working')
      if (replacement !== 'work') {
        server.observeJcodeTerminalTitle(PANE, LAST)
        vi.advanceTimersByTime(2_000)
        expect(server.getStatusSnapshot()[0].state).toBe('working')
      }
      arm()
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('done')
    }
  )

  it('keeps a pending root settle through a rejected worker turn_start', () => {
    send()
    arm()
    vi.advanceTimersByTime(1_000)
    expect(send({ ...TURN_START, session_id: 'worker' })).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(server.getStatusSnapshot()[0].state).toBe('done')
  })

  it('does not arm from last alone or an identity-only work predecessor', () => {
    send()
    server.observeJcodeTerminalTitle(PANE, LAST)
    vi.advanceTimersByTime(2_000)
    expect(server.getStatusSnapshot()[0].state).toBe('working')
    server.observeJcodeTerminalTitle(PANE, '🦨 jcode/castle Skunk')
    server.observeJcodeTerminalTitle(PANE, LAST)
    vi.advanceTimersByTime(2_000)
    expect(server.getStatusSnapshot()[0].state).toBe('working')
  })

  it.each([
    'replay',
    'restored',
    'non-jcode',
    'session-mismatch',
    'remote',
    'identity-only',
    'child',
    'root-done'
  ])('refuses %s rows even with native title activity', (ineligible) => {
    const start = send()
    if (!start) {
      throw new Error('missing captured start')
    }
    if (ineligible === 'restored' || ineligible === 'non-jcode' || ineligible === 'identity-only') {
      const root = state.lastStatusByPaneKey.get(PANE)
      if (!root) {
        throw new Error('missing host row')
      }
      const restored = {
        ...root,
        ...(ineligible === 'restored' ? { restoredUnconfirmed: true as const } : {}),
        providerSessionOnly: ineligible === 'identity-only',
        source: ineligible === 'non-jcode' ? ('claude' as const) : ('jcode' as const),
        payload: { ...root.payload, agentType: ineligible === 'non-jcode' ? 'claude' : 'jcode' }
      }
      seedLegacyAgentStatusForTests(state, restored)
    } else {
      server.ingestRemote(
        {
          ...start,
          isReplay: ineligible === 'replay',
          providerSessionOnly: ineligible === 'identity-only',
          ...(ineligible === 'child' ? { toolAgentId: 'worker' } : {}),
          providerSession: {
            key: 'session_id',
            id: ineligible === 'session-mismatch' ? 'other' : TURN_START.session_id
          },
          payload: {
            ...start.payload,
            agentType: ineligible === 'non-jcode' ? 'claude' : 'jcode',
            ...(ineligible === 'root-done'
              ? { mainAgent: { state: 'done' as const, stateStartedAt: Date.now() } }
              : {})
          }
        },
        ineligible === 'remote' ? 'ssh-connection' : null
      )
    }
    const baseline = server.getStatusSnapshot()
    arm()
    vi.advanceTimersByTime(2_000)
    expect(server.getStatusSnapshot()).toEqual(baseline)
    expect(state.jcodeTurnByPaneKey.get(PANE)?.active).toBe(true)
  })

  it.each(['launch', 'owner', 'handle'])(
    'invalidates an edge after %s replacement',
    (replacement) => {
      send()
      arm()
      send(
        TOOL,
        replacement === 'launch'
          ? { launchToken: 'replacement' }
          : replacement === 'owner'
            ? { worktreeId: 'replacement-worktree' }
            : { terminalHandle: 'replacement-handle' }
      )
      if (replacement === 'handle') {
        const root = state.lastStatusByPaneKey.get(PANE)
        if (!root) {
          throw new Error('missing host row')
        }
        seedLegacyAgentStatusForTests(state, { ...root, terminalHandle: 'replacement-handle' })
      }
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('working')
    }
  )

  it.each(['clear', 'drop', 'remint'])('clears pending timers on pane %s', (cleanup) => {
    send()
    const baselineTimers = vi.getTimerCount()
    arm()
    expect(vi.getTimerCount()).toBe(baselineTimers + 1)
    if (cleanup === 'clear') {
      server.clearPaneState(PANE)
    } else if (cleanup === 'drop') {
      server.dropStatusEntry(PANE)
    } else {
      server.transferPaneAuthority(PANE, GOOD_PANE)
    }
    expect(vi.getTimerCount()).toBe(baselineTimers)
    const baseline = server.getStatusSnapshot()
    vi.advanceTimersByTime(2_000)
    expect(server.getStatusSnapshot()).toEqual(baseline)
    if (cleanup === 'remint') {
      server.observeJcodeTerminalTitle(GOOD_PANE, LAST)
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('working')
      server.observeJcodeTerminalTitle(GOOD_PANE, WORK)
      server.observeJcodeTerminalTitle(GOOD_PANE, LAST)
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('done')
    }
  })

  it.each(['disabled', 'stop', 'stop-keep-status'])('clears pending timers on %s', (cleanup) => {
    send()
    const baselineTimers = vi.getTimerCount()
    arm()
    expect(vi.getTimerCount()).toBe(baselineTimers + 1)
    if (cleanup === 'disabled') {
      server.setStatusHooksEnabled(false)
      server.setStatusHooksEnabled(true)
    } else {
      server.stop({ keepStatus: cleanup === 'stop-keep-status' })
    }
    expect(vi.getTimerCount()).toBe(baselineTimers)
    const baseline = server.getStatusSnapshot()
    vi.advanceTimersByTime(2_000)
    expect(server.getStatusSnapshot()).toEqual(baseline)
    if (cleanup === 'disabled') {
      server.observeJcodeTerminalTitle(PANE, LAST)
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('working')
      arm()
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('done')
    }
  })
})
