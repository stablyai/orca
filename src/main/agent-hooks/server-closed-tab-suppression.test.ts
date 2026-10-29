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

  // Reattach must restore mid-turn and idle panes without waiting for a new-turn event.
  for (const kind of ['pi', 'omp'] as const) {
    it(`re-attaching a retired ${kind} pane restores status without needing a new turn`, async () => {
      const server = new AgentHookServer()
      await server.start({ env: 'production' })
      try {
        const env = server.buildPtyEnv()
        const postHook = (payload: Record<string, unknown>): Promise<Response> =>
          fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${kind}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body: JSON.stringify(buildBody(payload, { launchToken: `retired-${kind}-token` }))
          })

        await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
        server.retirePaneAuthority(PANE)

        // A surviving turn may have only its completion left to report.
        await postHook({ hook_event_name: 'agent_end' })
        expect(server.getStatusSnapshot()).toEqual([])

        expect(server.restorePaneAuthority(PANE)).toBe(true)

        await postHook({ hook_event_name: 'agent_end' })
        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({ paneKey: PANE, state: 'done' })
        ])
      } finally {
        server.stop()
      }
    })
  }

  it('re-attaching an idle retired pane accepts completion and a later turn', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'idle-reattach-token' }))
        })

      server.retirePaneAuthority(PANE)
      expect(server.restorePaneAuthority(PANE)).toBe(true)

      // Use a completion event to distinguish reattach revival from new-turn revival.
      await postHook({ hook_event_name: 'agent_end' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done' })
      ])

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'much later turn' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', prompt: 'much later turn' })
      ])
    } finally {
      server.stop()
    }
  })

  it('re-attach does not lift a closed-tab tombstone', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'closed-tab-token' }))
        })

      server.retirePaneAuthority(PANE)
      server.dropStatusEntriesByTabPrefix('tab-1')
      expect(server.restorePaneAuthority(PANE)).toBe(false)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after tab close' })
      expect(server.getStatusSnapshot()).toEqual([])

      expect(server.restorePaneAuthority(PANE)).toBe(false)
    } finally {
      server.stop()
    }
  })

  // Reattach must rebuild retired aliases because the live process still posts its original pane key.
  it('re-attaching a detached pane accepts hooks on the pane key its process launched under', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'detached-token' }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      // Detached processes keep posting their original key; aliases route them to the new owner.
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      expect(server.restorePaneAuthority(detachedPane)).toBe(true)

      await postHook({ hook_event_name: 'agent_end' })
      // Restoring fences without aliases would create a duplicate row under the old key.
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: detachedPane, state: 'done' })
      ])
    } finally {
      server.stop()
    }
  })

  it('re-attaching restores a legacy numeric pane key alias', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const legacyPane = 'tab-1:0'
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody(payload, { paneKey: legacyPane, launchToken: 'legacy-token' })
          )
        })

      server.registerPaneKeyAlias(legacyPane, PANE, 'pty-legacy')
      await postHook({ hook_event_name: 'before_agent_start', prompt: 'legacy turn' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working' })
      ])

      server.retirePaneAuthority(PANE)
      expect(server.restorePaneAuthority(PANE)).toBe(true)

      await postHook({ hook_event_name: 'agent_end' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done' })
      ])
    } finally {
      server.stop()
    }
  })

  it('does not rebuild a detached pane alias into a closed tab', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'detached-closed-token' }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      // Closed-tab ownership overrides pane restoration.
      server.dropStatusEntriesByTabPrefix('tab-2')
      expect(server.restorePaneAuthority(detachedPane)).toBe(false)

      await postHook({ hook_event_name: 'agent_end' })
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  // Restoring the original key must not rebuild an alias into the closed owner tab.
  it('re-opens the original pane instead of rebuilding an alias into a closed tab', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'reopen-origin-token' }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-2')

      expect(server.restorePaneAuthority(PANE)).toBe(true)

      await postHook({ hook_event_name: 'agent_end' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done' })
      ])
    } finally {
      server.stop()
    }
  })

  // After tab-ID eviction, the pane fence must remain; use a non-boundary event that cannot lift it.
  it('leaves a closed tab pane fenced once its tab id is evicted', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (
        payload: Record<string, unknown>,
        overrides: Record<string, unknown> = {}
      ): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'evict-token', ...overrides }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-2')
      expect(server.restorePaneAuthority(PANE)).toBe(true)

      for (let i = 0; i <= CLOSED_AGENT_STATUS_TAB_IDS_MAX; i += 1) {
        server.dropStatusEntriesByTabPrefix(`tab-evict-${i}`)
      }

      await postHook(
        { hook_event_name: 'agent_end', prompt: 'after eviction' },
        { paneKey: detachedPane, tabId: 'tab-2' }
      )
      expect(server.getStatusSnapshot()).toEqual([])

      // An unfenced control proves the event itself is active.
      await postHook(
        { hook_event_name: 'agent_end', prompt: 'unfenced control' },
        { paneKey: makePaneKey('tab-9', LEAF_3), tabId: 'tab-9' }
      )
      expect(server.getStatusSnapshot()).toHaveLength(1)
    } finally {
      server.stop()
    }
  })

  // Detached legacy aliases can span tabs; their own closed tab must remain fenced.
  it('keeps a legacy alias fenced when its own tab closed but the owner tab did not', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const legacyPane = 'tab-1:0'
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody(payload, { paneKey: legacyPane, launchToken: 'legacy-cross-tab-token' })
          )
        })

      server.registerPaneKeyAlias(legacyPane, PANE, 'pty-cross')
      server.transferPaneAuthority(PANE, detachedPane, 'pty-cross')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-1')

      // Restore the open owner without reviving an alias from the closed tab.
      expect(server.restorePaneAuthority(detachedPane)).toBe(true)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after tab-1 close' })
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('does not clobber a newer alias when replaying a retired fence', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const legacyPane = 'tab-1:0'
      const reboundPane = makePaneKey('tab-1', LEAF_3)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody(payload, { paneKey: legacyPane, launchToken: 'rebind-token' })
          )
        })

      server.registerPaneKeyAlias(legacyPane, PANE, 'pty-old')
      server.retirePaneAuthority(PANE)
      server.registerPaneKeyAlias(legacyPane, reboundPane, 'pty-new')
      server.restorePaneAuthority(PANE)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after rebind' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: reboundPane, state: 'working' })
      ])
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

      // Idle Claude resume emits only SessionStart; restoration cannot wait for a prompt.
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

    const refreshedTab = `closed-tab-${total - CLOSED_AGENT_STATUS_TAB_IDS_MAX}`
    const nextOldestTab = `closed-tab-${total - CLOSED_AGENT_STATUS_TAB_IDS_MAX + 1}`
    internals.markTabClosedForAgentStatus(refreshedTab)
    internals.markTabClosedForAgentStatus('closed-tab-next')

    expect(internals.closedAgentStatusTabIds.has(refreshedTab)).toBe(true)
    expect(internals.closedAgentStatusTabIds.has(nextOldestTab)).toBe(false)
    expect(internals.closedAgentStatusTabIds.size).toBe(CLOSED_AGENT_STATUS_TAB_IDS_MAX)
    expect(internals.closedAgentStatusTabIds.has('closed-tab-0')).toBe(false)
    expect(internals.closedAgentStatusTabIds.has(`closed-tab-${total - 1}`)).toBe(true)
  })
})
