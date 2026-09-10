import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildBody, PANE, LEAF_2, LEAF_3 } from './server.test-fixtures'

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

async function postClaudeHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
}

describe('AgentHookServer listener replay', () => {
  it('accepts raw JSON hook bodies with base64 metadata headers', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          'X-Orca-Agent-Hook-Meta': Buffer.from(
            [PANE, 'tab-1', '', 'wt-1', 'production', ''].join('\x1f')
          ).toString('base64')
        },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'raw JSON' })
      })

      expect(response.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          worktreeId: 'wt-1',
          state: 'working',
          prompt: 'raw JSON'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('caches and notifies status/main/plugin before retry scheduling and HTTP response', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const order: string[] = []
    const internal = server as unknown as {
      scheduleAssistantMessageRetry: (...args: unknown[]) => void
      scheduleCodexSubagentPoll: (...args: unknown[]) => void
    }
    const originalAssistantRetry = internal.scheduleAssistantMessageRetry.bind(server)
    const originalCodexRetry = internal.scheduleCodexSubagentPoll.bind(server)
    const assistantRetry = vi
      .spyOn(internal, 'scheduleAssistantMessageRetry')
      .mockImplementation((...args) => {
        order.push('assistant-retry')
        originalAssistantRetry(...args)
      })
    const codexRetry = vi
      .spyOn(internal, 'scheduleCodexSubagentPoll')
      .mockImplementation((...args) => {
        order.push('codex-retry')
        originalCodexRetry(...args)
      })
    const unsubscribeStatus = server.subscribeStatusChanges(() => order.push('status-change'))
    server.setListener(() => {
      expect(server.getStatusSnapshotForPane(PANE)).toHaveLength(1)
      order.push('main-listener')
    })
    const unsubscribePlugin = server.subscribeEnrichedStatus(() => order.push('plugin-listener'))
    try {
      const response = await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ordered'
      })
      order.push('response')
      expect(response.status).toBe(204)
      expect(order).toEqual([
        'status-change',
        'main-listener',
        'plugin-listener',
        'assistant-retry',
        'codex-retry',
        'response'
      ])
    } finally {
      unsubscribeStatus()
      unsubscribePlugin()
      assistantRetry.mockRestore()
      codexRetry.mockRestore()
      server.stop()
    }
  })

  it('fails open after a throwing callback with cache retained and retries skipped', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const internal = server as unknown as {
      scheduleAssistantMessageRetry: (...args: unknown[]) => void
      scheduleCodexSubagentPoll: (...args: unknown[]) => void
    }
    const assistantRetry = vi.spyOn(internal, 'scheduleAssistantMessageRetry')
    const codexRetry = vi.spyOn(internal, 'scheduleCodexSubagentPoll')
    server.setListener(() => {
      throw new Error('listener failed')
    })
    try {
      const response = await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'cached before callback'
      })
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshotForPane(PANE)).toHaveLength(1)
      expect(assistantRetry).not.toHaveBeenCalled()
      expect(codexRetry).not.toHaveBeenCalled()
    } finally {
      assistantRetry.mockRestore()
      codexRetry.mockRestore()
      server.stop()
    }
  })
  it('ignores local nested Claude Stop while a parent Codex hook status is active', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)
      const postHook = async (
        source: 'codex' | 'claude',
        payload: Record<string, unknown>
      ): Promise<void> => {
        const response = await fetch(
          `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body: JSON.stringify(buildBody(payload))
          }
        )
        expect(response.status).toBe(204)
      }

      await postHook('codex', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'parent codex'
      })
      await postHook('claude', {
        hook_event_name: 'Stop',
        last_assistant_message: 'child finished'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'parent codex',
          agentType: 'codex'
        })
      ])
      const snapshot = server.getStatusSnapshot()[0]
      expect(snapshot.lastAssistantMessage).toBeUndefined()
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
    } finally {
      server.stop()
    }
  })

  it('does not apply Claude background evidence from a rejected local status', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
        expect(response.status).toBe(204)
      }

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        prompt: 'approve shell',
        tool_name: 'Bash',
        background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }],
        session_crons: [{ id: 'cron-1', status: 'running' }]
      })
      const waiting = server.getStatusSnapshot()[0]

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        prompt: 'approve shell',
        tool_name: 'OtherTool',
        background_tasks: [],
        session_crons: []
      })

      expect(server.getStatusSnapshot()[0]).toEqual(waiting)
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(true)
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('maps registered legacy numeric HTTP pane keys to stable pane keys', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.registerPaneKeyAlias('tab-1:0', PANE)
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'legacy pane'
            },
            { paneKey: 'tab-1:0' }
          )
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'legacy pane',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('tracks hook posts with an empty paneKey before dropping them', async () => {
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
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'missing pane'
            },
            { paneKey: '' }
          )
        )
      })
      const listener = vi.fn()
      server.setListener(listener)

      expect(response.status).toBe(204)
      expect(listener).not.toHaveBeenCalled()
      expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
        reason: 'empty_pane_key'
      })
    } finally {
      server.stop()
    }
  })

  // Why (agent-status-over-SSH §3): ingestRemote must run the same warn-once diagnostics as the local HTTP path so stale remote hooks signal locally.
  it('runs warn-once env/version diagnostics on relay-forwarded events', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: PANE,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          connectionId: 'conn-1',
          payload: expect.objectContaining({ state: 'working', agentType: 'claude' })
        })
      )

      const warnCalls = warn.mock.calls.map((c) => String(c[0]))
      expect(warnCalls.some((m) => m.includes('v999'))).toBe(true)
      expect(warnCalls.some((m) => m.includes('development') && m.includes('production'))).toBe(
        true
      )

      const warnsAfterFirst = warn.mock.calls.length
      const secondPane = makePaneKey('tab-2', LEAF_2)
      server.ingestRemote(
        {
          paneKey: secondPane,
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: secondPane,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )
      expect(warn.mock.calls.length).toBe(warnsAfterFirst)
      // Why: assert fanout still fires on the second event too, else a refactor that drops it would pass on warn-count alone.
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      server.stop()
    }
  })

  it('treats remote env as normal relay traffic and normalizes payload at the trust boundary', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      const oversizedPrompt = 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH + 50)
      const remotePane = makePaneKey('tab-3', LEAF_3)
      server.ingestRemote(
        {
          paneKey: ` ${remotePane} `,
          tabId: ' tab-3 ',
          worktreeId: ' wt-3 ',
          env: 'remote',
          version: '1',
          payload: {
            state: 'done',
            prompt: oversizedPrompt,
            agentType: 'codex'
          }
        },
        ' conn-9 '
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: remotePane,
          tabId: 'tab-3',
          worktreeId: 'wt-3',
          connectionId: 'conn-9',
          payload: expect.objectContaining({
            state: 'done',
            agentType: 'codex',
            prompt: 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)
          })
        })
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('accepts form-encoded hook posts from Unix managed scripts', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const params = new URLSearchParams({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'repo::/tmp/worktree with "quotes"',
        env: 'production',
        version: env.ORCA_AGENT_HOOK_VERSION ?? '',
        payload: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'form encoded'
        })
      })

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: params
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'repo::/tmp/worktree with "quotes"',
          connectionId: null,
          receivedAt: expect.any(Number),
          stateStartedAt: expect.any(Number),
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'form encoded',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('tracks Codex agent statuses from form-encoded managed hook posts', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)
      const postCodexHook = async (payload: Record<string, unknown>): Promise<void> => {
        const params = new URLSearchParams({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'production',
          version: env.ORCA_AGENT_HOOK_VERSION ?? '',
          payload: JSON.stringify(payload)
        })
        const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: params
        })
        expect(response.status).toBe(204)
      }

      await postCodexHook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ship codex hook status'
      })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          state: 'working',
          agentType: 'codex',
          prompt: 'ship codex hook status',
          toolName: undefined,
          toolInput: undefined
        })
      ])

      await postCodexHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pnpm test', workdir: '/repo' }
      })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          agentType: 'codex',
          prompt: 'ship codex hook status',
          toolName: 'exec_command',
          toolInput: 'pnpm test'
        })
      ])

      await postCodexHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git push', workdir: '/repo' }
      })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'waiting',
          agentType: 'codex',
          prompt: 'ship codex hook status',
          toolName: 'exec_command',
          toolInput: 'git push'
        })
      ])

      await postCodexHook({
        hook_event_name: 'Stop',
        last_assistant_message: 'done'
      })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          agentType: 'codex',
          prompt: 'ship codex hook status',
          lastAssistantMessage: 'done'
        })
      ])
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: expect.objectContaining({
            state: 'done',
            agentType: 'codex',
            prompt: 'ship codex hook status',
            lastAssistantMessage: 'done'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('accepts Hermes plugin hook posts on /hook/hermes', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/hermes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'pre_llm_call',
            user_message: 'verify Hermes route'
          })
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'verify Hermes route',
            agentType: 'hermes'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('accepts Amp plugin hook posts on /hook/amp', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/amp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'agent.start',
            message: 'verify Amp route'
          })
        )
      })
      expect(response.status).toBe(204)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'verify Amp route',
            agentType: 'amp'
          })
        })
      )
    } finally {
      server.stop()
    }
  })
})
