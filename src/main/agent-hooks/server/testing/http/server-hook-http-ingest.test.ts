import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
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
})
