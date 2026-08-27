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
  it('beforeSubmitPrompt maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'add a README' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.prompt).toBe('add a README')
  })

  it('stop maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.interrupted).toBeUndefined()
  })

  it('stop with non-completed status marks the turn interrupted', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'cancelled' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.interrupted).toBe(true)
  })

  it('beforeShellExecution maps to working with the pending command as toolInput', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeShellExecution', command: 'rm -rf /tmp/foo' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Shell')
    expect(result?.payload.toolInput).toBe('rm -rf /tmp/foo')
  })

  it('beforeMCPExecution maps to working', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeMCPExecution', tool_name: 'fetch', url: 'https://x' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('fetch')
  })

  it('preToolUse surfaces tool name + input preview and stays working', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/app.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/repo/src/app.ts')
  })

  it('postToolUseFailure surfaces the error and clears stale tool fields', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/app.ts' }
      }),
      'production'
    )
    const failed = _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'postToolUseFailure',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/app.ts' },
        error_message: 'file not found'
      }),
      'production'
    )
    // Why: keeping toolName would let the compact sidebar show the tool instead of the failure text, hiding the error.
    expect(failed?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'file not found'
    })
    expect(failed?.payload.toolName).toBeUndefined()
    expect(failed?.payload.toolInput).toBeUndefined()
  })

  it('afterAgentResponse carries text into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'afterAgentResponse', text: 'Done — wrote the README.' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Done — wrote the README.')
  })

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

  it('tool-heavy turn keeps working across shell and generic tool hooks until stop', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'run checks' }),
      'production'
    )
    const shell = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeShellExecution', command: 'pnpm test' }),
      'production'
    )
    expect(shell?.payload.state).toBe('working')
    const tool = _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/app.ts' }
      }),
      'production'
    )
    expect(tool?.payload.state).toBe('working')
    const stop = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('run checks')
  })

  it('beforeSubmitPrompt clears the cached tool state from a prior turn', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({
        hook_event_name: 'preToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'new turn' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new turn')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('subsequent stop preserves the cached prompt from beforeSubmitPrompt', () => {
    _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'beforeSubmitPrompt', prompt: 'add tests' }),
      'production'
    )
    const stop = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'stop', status: 'completed' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('add tests')
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      'cursor',
      buildBody({ hook_event_name: 'somethingElse' }),
      'production'
    )
    expect(result).toBeNull()
  })
})
