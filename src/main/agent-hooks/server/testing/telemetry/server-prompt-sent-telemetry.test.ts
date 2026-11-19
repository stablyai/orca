import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

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

  it('counts each prompt a person sends into an already open Claude turn once', () => {
    const server = new AgentHookServer()
    const ingest = (fields: Record<string, unknown>, prompt: string) =>
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'claude',
          providerPromptId: '0b6f1a52-2f43-4f0e-9d55-0c9f6a1e2b31',
          ...fields,
          payload: { state: 'working', prompt, agentType: 'claude' }
        },
        'conn-1'
      )
    ingest({ hookEventName: 'PreToolUse', opensTurn: true }, '')
    const late = { hookEventName: 'UserPromptSubmit:late', lateExplicitPrompt: true }
    ingest(late, 'also this')
    ingest(late, 'start the task')
    ingest(late, 'start the task')

    expect(trackMock).toHaveBeenCalledTimes(2)
  })
})
