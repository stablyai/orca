import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, GOOD_PANE, FRESH_PANE } from './server.test-fixtures'

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

describe('AgentHookServer prompt-sent telemetry', () => {
  it('tracks a live local hook explicit prompt with conservative attribution', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'UserPromptSubmit',
            prompt: '  fix the spinner  '
          })
        )
      })

      expect(response.status).toBe(204)
      expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
        agent_kind: 'claude-code',
        launch_source: 'unknown',
        request_kind: 'followup',
        nth_repo_added: 2
      })
    } finally {
      server.stop()
    }
  })

  it('tracks a live SSH hook explicit prompt through ingestRemote', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'remote prompt', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'codex',
      launch_source: 'unknown',
      request_kind: 'followup',
      nth_repo_added: 2
    })
  })

  it('dedupes adjacent same-turn reports without considering hook state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'same turn', agentType: 'gemini' }
        },
        'conn-1'
      )
      vi.setSystemTime(1_500)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'done', prompt: 'same turn', agentType: 'gemini' }
        },
        'conn-1'
      )

      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
        agent_kind: 'gemini',
        launch_source: 'unknown',
        request_kind: 'followup',
        nth_repo_added: 2
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks the same prompt again after a completed turn starts over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'continue', agentType: 'codex' }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'continue', agentType: 'codex' }
        },
        'conn-1'
      )
      vi.setSystemTime(1_500)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'continue', agentType: 'codex' }
        },
        'conn-1'
      )

      expect(trackMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dedupes duplicate Command Code stop hooks but tracks same-prompt reruns', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-user-1',
        payload: { state: 'done', prompt: 'rerun', agentType: 'command-code' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-user-1',
        payload: { state: 'done', prompt: 'rerun', agentType: 'command-code' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-user-2',
        payload: { state: 'done', prompt: 'rerun', agentType: 'command-code' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(2)
  })

  it('includes Command Code prompt interaction keys in the IPC snapshot', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-user-1',
        payload: { state: 'working', prompt: 'rerun', agentType: 'command-code' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      paneKey: PANE,
      promptInteractionKey: 'command-code-transcript-user-1',
      state: 'working',
      prompt: 'rerun',
      agentType: 'command-code'
    })
  })

  it('dedupes Command Code direct prompt hooks followed by transcript-backed stop hooks', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'same command', agentType: 'command-code' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-a-1',
        payload: { state: 'done', prompt: 'same command', agentType: 'command-code' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(1)
  })

  it('does not let a reused interaction key suppress different prompt text', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-reused',
        payload: { state: 'done', prompt: 'first command', agentType: 'command-code' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        promptInteractionKey: 'command-code-transcript-reused',
        payload: { state: 'done', prompt: 'second command', agentType: 'command-code' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(2)
  })

  it('does not treat Command Code cached prompts as explicit prompt evidence', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'done', prompt: 'cached prompt', agentType: 'command-code' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: false,
        payload: { state: 'done', prompt: 'cached prompt', agentType: 'command-code' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(1)
  })

  it('preserves prompt dedupe when a live status row is dismissed', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'long turn', agentType: 'codex' }
      },
      'conn-1'
    )
    server.dropStatusEntry(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'long turn', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(1)
  })

  it('lets a dismissed completed row start the same prompt again', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'done', prompt: 'rerun after done', agentType: 'codex' }
      },
      'conn-1'
    )
    server.dropStatusEntry(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'rerun after done', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledTimes(2)
  })

  it('dedupes the same prompt until a completed turn boundary is observed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'repeat later', agentType: 'codex' }
        },
        'conn-1'
      )
      vi.setSystemTime(32_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'repeat later', agentType: 'codex' }
        },
        'conn-1'
      )

      expect(trackMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not track replays, empty prompts, or inherited prompt snapshots', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        isReplay: true,
        payload: { state: 'working', prompt: 'replayed prompt', agentType: 'codex' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: GOOD_PANE,
        tabId: 'tab-good',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: '   ', agentType: 'codex' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'inherited prompt', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track hook status messages that preserve a cached prompt', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'real prompt', agentType: 'droid' }
      },
      'conn-1'
    )
    trackMock.mockClear()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: false,
        payload: { state: 'waiting', prompt: 'real prompt', agentType: 'droid' }
      },
      'conn-1'
    )

    expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('tracks OpenCode user MessagePart hooks once per message id', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'MessagePart',
            role: 'user',
            text: 'fix',
            messageID: 'msg-1'
          })
        )
      })
      const updatedResponse = await fetch(
        `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody({
              hook_event_name: 'MessagePart',
              role: 'user',
              text: 'fix tests',
              messageID: 'msg-1'
            })
          )
        }
      )

      expect(response.status).toBe(204)
      expect(updatedResponse.status).toBe(204)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'fix tests',
        agentType: 'opencode'
      })
      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
        agent_kind: 'opencode',
        launch_source: 'unknown',
        request_kind: 'followup',
        nth_repo_added: 2
      })
    } finally {
      server.stop()
    }
  })

  it('maps custom hook agent types to other', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'custom prompt', agentType: 'my-local-agent' }
      },
      'conn-1'
    )

    expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'other',
      launch_source: 'unknown',
      request_kind: 'followup',
      nth_repo_added: 2
    })
  })

  it('does not block status cache mutation or listener fanout when telemetry throws', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable')
    })
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'keep status moving', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        prompt: 'keep status moving',
        agentType: 'codex'
      })
    ])
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        payload: expect.objectContaining({ prompt: 'keep status moving' })
      })
    )
    errorSpy.mockRestore()
  })
})
