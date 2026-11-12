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

describe('AgentHookServer prompt-sent telemetry', () => {
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
