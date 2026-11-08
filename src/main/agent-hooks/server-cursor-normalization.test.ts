import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

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

describe('Cursor hook normalization', () => {
  it('late afterAgentResponse after stop keeps Cursor done instead of resurrecting working', () => {
    const submit = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'add tests' }),
      'production'
    )
    expect(submit).not.toBeNull()
    if (!submit) {
      throw new Error('expected Cursor beforeSubmitPrompt to normalize')
    }
    agentHookServer.ingestRemote(
      {
        paneKey: submit.paneKey,
        tabId: submit.tabId,
        worktreeId: submit.worktreeId,
        payload: submit.payload
      },
      'conn-1'
    )

    const stop = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(stop).not.toBeNull()
    if (!stop) {
      throw new Error('expected Cursor stop to normalize')
    }
    agentHookServer.ingestRemote(
      {
        paneKey: stop.paneKey,
        tabId: stop.tabId,
        worktreeId: stop.worktreeId,
        payload: stop.payload
      },
      'conn-1'
    )

    const response = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'afterAgentResponse', text: 'All set.' }),
      'production'
    )
    expect(response?.payload.state).toBe('done')
    expect(response?.payload.lastAssistantMessage).toBe('All set.')
    if (!response) {
      throw new Error('expected Cursor afterAgentResponse to normalize')
    }

    agentHookServer.ingestRemote(
      {
        paneKey: response.paneKey,
        tabId: response.tabId,
        worktreeId: response.worktreeId,
        payload: response.payload
      },
      'conn-1'
    )
    expect(agentHookServer.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'done',
        agentType: 'cursor',
        prompt: 'add tests',
        lastAssistantMessage: 'All set.'
      })
    ])
  })
})
