import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AgentHookServer, CLOSED_AGENT_STATUS_TAB_IDS_MAX, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  buildBody,
  PANE,
  GOOD_PANE,
  LEAF_2,
  LEAF_3,
  type AgentHookServerCacheInternals
} from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('drops cached statuses and pane-scoped listener caches under one tab prefix', () => {
    vi.useFakeTimers()
    try {
      const server = new AgentHookServer()
      const internals = server as unknown as AgentHookServerCacheInternals
      const sameTabPane = makePaneKey('tab-1', LEAF_2)
      const siblingPrefixPane = makePaneKey('tab-10', LEAF_3)
      const statusListener = vi.fn()
      const aliasPersist = vi.fn()
      const sameTabRetry = vi.fn()
      const siblingRetry = vi.fn()
      server.subscribeStatusChanges(statusListener)
      server.setPaneKeyAliasPersistenceListener(aliasPersist)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'first', agentType: 'claude' }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: sameTabPane,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'second', agentType: 'codex' }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: siblingPrefixPane,
          tabId: 'tab-10',
          worktreeId: 'wt-2',
          payload: { state: 'working', prompt: 'sibling', agentType: 'claude' }
        },
        'conn-1'
      )
      server.registerPaneKeyAlias('tab-1:0', sameTabPane, 'pty-1')
      const state = server._getStateForTests()
      state.lastPromptByPaneKey.set(PANE, 'cached prompt')
      state.lastToolByPaneKey.set(`${sameTabPane}\0tool`, {} as never)
      state.antigravityCompletedTranscriptByPaneKey.set(`${sameTabPane}\0done`, 'cached')
      state.ampCompletedCacheKeys.add(`${sameTabPane}\0amp`)
      state.lastPromptByPaneKey.set(siblingPrefixPane, 'sibling prompt')
      internals.assistantMessageRetryTimers.set(PANE, setTimeout(sameTabRetry, 1_000))
      internals.assistantMessageRetryTimers.set(siblingPrefixPane, setTimeout(siblingRetry, 1_000))
      internals.promptSentDedupeByPaneKey.set(PANE, { promptHash: 'same-tab' })
      internals.promptSentDedupeByPaneKey.set(siblingPrefixPane, { promptHash: 'sibling' })
      const scheduleStatusPersist = vi.spyOn(internals, 'scheduleStatusPersist')
      statusListener.mockClear()
      aliasPersist.mockClear()
      scheduleStatusPersist.mockClear()

      server.dropStatusEntriesByTabPrefix('tab-1')

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: siblingPrefixPane, prompt: 'sibling' })
      ])
      expect(state.lastPromptByPaneKey.has(PANE)).toBe(false)
      expect(state.lastToolByPaneKey.has(`${sameTabPane}\0tool`)).toBe(false)
      expect(state.antigravityCompletedTranscriptByPaneKey.has(`${sameTabPane}\0done`)).toBe(false)
      expect(state.ampCompletedCacheKeys.has(`${sameTabPane}\0amp`)).toBe(false)
      expect(state.lastPromptByPaneKey.get(siblingPrefixPane)).toBe('sibling prompt')
      expect(internals.assistantMessageRetryTimers.has(PANE)).toBe(false)
      expect(internals.assistantMessageRetryTimers.has(siblingPrefixPane)).toBe(true)
      expect(internals.promptSentDedupeByPaneKey.has(PANE)).toBe(false)
      expect(internals.promptSentDedupeByPaneKey.get(siblingPrefixPane)).toEqual({
        promptHash: 'sibling'
      })
      expect(internals.runtimeObservedStatusPaneKeys.has(PANE)).toBe(false)
      expect(internals.runtimeObservedStatusPaneKeys.has(sameTabPane)).toBe(false)
      expect(internals.runtimeObservedStatusPaneKeys.has(siblingPrefixPane)).toBe(true)
      expect(statusListener).toHaveBeenCalledTimes(1)
      expect(statusListener).toHaveBeenCalledWith([
        expect.objectContaining({ state: 'working', observedInCurrentRuntime: true })
      ])
      expect(aliasPersist).toHaveBeenCalledTimes(1)
      expect(aliasPersist).toHaveBeenCalledWith([])
      expect(scheduleStatusPersist).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1_000)
      expect(sameTabRetry).not.toHaveBeenCalled()
      expect(siblingRetry).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('suppresses late writes for a closed tab for the rest of the server session', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'before close', agentType: 'codex' }
        },
        'conn-1'
      )

      server.dropStatusEntriesByTabPrefix('tab-1')
      listener.mockClear()

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'late remote', agentType: 'codex' }
        },
        'conn-1'
      )
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'done', prompt: 'late terminal', agentType: 'codex' }
      })

      vi.setSystemTime(16_001)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'future reuse', agentType: 'codex' }
        },
        'conn-1'
      )

      expect(listener).not.toHaveBeenCalled()
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts statuses for unrelated tabs while another tab is recently closed', () => {
    const server = new AgentHookServer()
    server.dropStatusEntriesByTabPrefix('tab-1')
    server.ingestRemote(
      {
        paneKey: GOOD_PANE,
        tabId: 'tab-good',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'unrelated', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: GOOD_PANE, state: 'working', prompt: 'unrelated' })
    ])
  })

  it('suppresses local HTTP hook writes for a recently closed tab', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (prompt: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody({ hook_event_name: 'UserPromptSubmit', prompt }))
        })

      await expect(postHook('before close')).resolves.toMatchObject({ status: 204 })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, prompt: 'before close' })
      ])

      server.dropStatusEntriesByTabPrefix('tab-1')
      await expect(postHook('late local')).resolves.toMatchObject({ status: 204 })

      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('accepts a new local prompt after launch authority retires in a reusable pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'retired-launch-token' }))
        })

      await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'first launch' })
      server.retirePaneAuthority(PANE)
      await postHook({ hook_event_name: 'Stop', last_assistant_message: 'late prior hook' })
      expect(server.getStatusSnapshot()).toEqual([])

      await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'manual restart' })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', prompt: 'manual restart' })
      ])
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update('retired-launch-token').digest('hex'),
          connectionId: null,
          terminalProvenance: 'current_runtime'
        })
      ).toBeNull()
    } finally {
      server.stop()
    }
  })

  it('accepts a resumed-session SessionStart after launch authority retires in a reusable pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'retired-launch-token' }))
        })

      await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'first launch' })
      server.retirePaneAuthority(PANE)

      // Why: `claude --resume` in the reused shell pane emits only SessionStart while idle;
      // without the un-retire the resumed session stays rowless until a prompt (STA-3386).
      await postHook({ hook_event_name: 'SessionStart', source: 'resume' })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done', sessionBoundary: true })
      ])
    } finally {
      server.stop()
    }
  })

  it('accepts a live remote prompt but not replay after launch authority retires', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        payload: { state: 'working', prompt: 'first launch', agentType: 'claude' }
      },
      'conn-1'
    )
    server.retirePaneAuthority(PANE)

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        isReplay: true,
        payload: { state: 'working', prompt: 'stale replay', agentType: 'claude' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()).toEqual([])

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        payload: { state: 'working', prompt: 'remote manual restart', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        prompt: 'remote manual restart',
        connectionId: 'conn-1'
      })
    ])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE,
        launchTokenHash: createHash('sha256').update('retired-remote-launch-token').digest('hex'),
        connectionId: 'conn-1',
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })
})

describe('AgentHookServer closed-tab suppression bound', () => {
  it('bounds closedAgentStatusTabIds with LRU eviction as tabs close', () => {
    const server = new AgentHookServer()
    const internals = server as unknown as {
      markTabClosedForAgentStatus: (tabId: string) => void
      closedAgentStatusTabIds: Set<string>
    }

    const total = CLOSED_AGENT_STATUS_TAB_IDS_MAX + 200
    for (let i = 0; i < total; i += 1) {
      internals.markTabClosedForAgentStatus(`closed-tab-${i}`)
    }

    // Set stays bounded; oldest ids are evicted, most-recent are retained.
    expect(internals.closedAgentStatusTabIds.size).toBe(CLOSED_AGENT_STATUS_TAB_IDS_MAX)
    expect(internals.closedAgentStatusTabIds.has('closed-tab-0')).toBe(false)
    expect(internals.closedAgentStatusTabIds.has(`closed-tab-${total - 1}`)).toBe(true)
  })
})
