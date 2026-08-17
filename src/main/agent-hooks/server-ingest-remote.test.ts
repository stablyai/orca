import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  parseAgentStatusPayload
} from '../../shared/agent-status-types'
import { PANE } from './server.test-fixtures'

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

describe('AgentHookServer ingestRemote', () => {
  it('caches and replays Pi session identity without exposing a turn-status change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const rendererListener = vi.fn()
      const statusChangeListener = vi.fn()
      server.setListener(rendererListener)
      server.subscribeStatusChanges(statusChangeListener)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          providerSession: {
            key: 'session_id',
            id: 'pi-session-1',
            transcriptPath: '/tmp/pi-session-1.jsonl'
          },
          providerSessionOnly: true,
          payload: { state: 'done', prompt: '', agentType: 'pi' }
        },
        'conn-1'
      )

      expect(rendererListener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          connectionId: 'conn-1',
          providerSessionOnly: true,
          providerSession: {
            key: 'session_id',
            id: 'pi-session-1',
            transcriptPath: '/tmp/pi-session-1.jsonl'
          }
        })
      )
      expect(statusChangeListener).toHaveBeenCalledWith([])
      expect(server.getStatusChangeSnapshot()).toEqual([])
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          providerSessionOnly: true,
          providerSession: expect.objectContaining({ transcriptPath: '/tmp/pi-session-1.jsonl' })
        })
      ])
      expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())

      const replayListener = vi.fn()
      server.setListener(replayListener)
      expect(replayListener).toHaveBeenCalledWith(
        expect.objectContaining({ paneKey: PANE, providerSessionOnly: true, isReplay: true })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('fans a Pi session-only status out to plugins, not just the renderer', () => {
    const server = new AgentHookServer()
    const rendererListener = vi.fn()
    const pluginListener = vi.fn()
    server.setListener(rendererListener)
    server.subscribeEnrichedStatus(pluginListener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/tmp/pi-session-1.jsonl'
        },
        providerSessionOnly: true,
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      'conn-1'
    )

    // The session-only path returns early, so it must not skip the plugin tap.
    expect(rendererListener).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: PANE, providerSessionOnly: true })
    )
    expect(pluginListener).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: PANE, providerSessionOnly: true })
    )
  })

  it('rejects invalid remote metadata-only session envelopes', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSessionOnly: true,
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSessionOnly: true,
        providerSession: { key: 'session_id', id: 'pi-session-1' },
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSessionOnly: true,
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/tmp/pi-session-1.jsonl'
        },
        payload: { state: 'done', prompt: '', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('stamps connectionId and forwards a valid relay envelope to the listener', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, 'conn-1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'conn-1',
        receivedAt: expect.any(Number),
        stateStartedAt: expect.any(Number),
        payload
      })
    )
  })

  it('preserves active pane identity when a nested remote hook reports another agent', () => {
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
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'parent codex', agentType: 'codex' }
        },
        'conn-1'
      )

      vi.setSystemTime(1_100)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: {
            state: 'working',
            prompt: 'nested claude',
            agentType: 'claude',
            toolName: 'Read',
            toolInput: '00-review-context.md'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'nested claude',
          agentType: 'codex',
          toolName: 'Read',
          toolInput: '00-review-context.md',
          receivedAt: 1_100
        })
      ])
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            prompt: 'nested claude',
            agentType: 'codex'
          })
        })
      )
      expect(trackMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores nested remote done while the parent pane agent is still active', () => {
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
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'parent codex', agentType: 'codex' }
        },
        'conn-1'
      )

      vi.setSystemTime(1_100)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: {
            state: 'done',
            prompt: 'nested claude',
            agentType: 'claude',
            toolName: 'Read',
            toolInput: '00-review-context.md',
            lastAssistantMessage: 'child finished'
          }
        },
        'conn-1'
      )

      const snapshot = server.getStatusSnapshot()
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]).toMatchObject({
        paneKey: PANE,
        state: 'working',
        prompt: 'parent codex',
        agentType: 'codex',
        receivedAt: 1_000,
        stateStartedAt: 1_000
      })
      expect(snapshot[0].toolName).toBeUndefined()
      expect(snapshot[0].toolInput).toBeUndefined()
      expect(snapshot[0].lastAssistantMessage).toBeUndefined()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'parent codex',
            agentType: 'codex'
          })
        })
      )
      expect(trackMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows remote pane identity to change after the prior turn is done', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'parent codex', agentType: 'codex' }
        },
        'conn-1'
      )

      vi.setSystemTime(1_100)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'real claude turn', agentType: 'claude' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'real claude turn',
          agentType: 'claude',
          receivedAt: 1_100
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows stale active remote pane identity to change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'old codex turn', agentType: 'codex' }
        },
        'conn-1'
      )

      vi.setSystemTime(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'new claude turn', agentType: 'claude' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'new claude turn',
          agentType: 'claude',
          receivedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets remote Claude permission clear when matching approved tool execution starts', () => {
    const server = new AgentHookServer()
    const waiting = parseAgentStatusPayload(
      JSON.stringify({
        state: 'waiting',
        agentType: 'claude',
        toolName: 'Bash',
        toolInput: 'pnpm test'
      })
    )
    const working = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        agentType: 'claude',
        toolName: 'Bash',
        toolInput: 'pnpm test'
      })
    )
    if (!waiting || !working) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'PermissionRequest',
        toolAgentId: 'agent-subagent-a',
        toolAgentType: 'Review',
        payload: waiting
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'PreToolUse',
        toolUseId: 'toolu-approved-remote',
        toolAgentId: 'agent-subagent-a',
        toolAgentType: 'Review',
        payload: working
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        connectionId: 'conn-1',
        state: 'working',
        agentType: 'claude',
        toolName: 'Bash',
        toolInput: 'pnpm test'
      })
    ])
  })

  it('drops envelopes whose payload state is not in AGENT_STATUS_STATES', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    // Why: bypass parseAgentStatusPayload with an invalid payload — ingestRemote is the trust boundary under test, not the parser.
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'nonsense', prompt: '', agentType: 'claude' }
      },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops envelopes whose paneKey exceeds MAX_PANE_KEY_LEN', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    // 201 chars — one past the listener's 200-char cap.
    const oversized = 'a'.repeat(201)
    server.ingestRemote(
      { paneKey: oversized, tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops remote relay envelopes with legacy numeric paneKeys before cache mutation', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: 'tab-1:0', tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('maps registered legacy numeric relay pane keys to stable pane keys', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.registerPaneKeyAlias('tab-1:0', PANE)
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: 'tab-1:0', tabId: 'tab-1', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'conn-1',
        payload
      })
    )
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        state: 'working',
        prompt: 'p'
      })
    ])
  })

  it('drops remote relay envelopes whose tabId disagrees with the paneKey tab', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 'tab-other', worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('rejects empty connectionId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, '')
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only connectionId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload }, '   ')
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects non-string tabId', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, tabId: 123 as unknown as string, worktreeId: 'wt-1', payload },
      'conn-1'
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects empty paneKey after trim', () => {
    const server = new AgentHookServer()
    const payload = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt: 'p', agentType: 'claude' })
    )
    if (!payload) {
      throw new Error('parseAgentStatusPayload returned null for a known-good fixture')
    }
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote({ paneKey: '   ', tabId: 'tab-1', worktreeId: 'wt-1', payload }, 'conn-1')
    expect(listener).not.toHaveBeenCalled()
    expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'empty_pane_key'
    })
  })

  it('normalizes inner payload via normalizeAgentStatusPayload — clamps oversized prompt', () => {
    // Why: a buggy/malicious relay could forward an over-cap field, so ingestRemote re-runs the normalizer to enforce the AGENT_STATUS_MAX_FIELD_LENGTH cap at the trust boundary.
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'x'.repeat(500), agentType: 'claude' }
      },
      'conn-1'
    )
    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as { payload: { prompt: string } }
    expect(event.payload.prompt.length).toBe(200)
  })
})
