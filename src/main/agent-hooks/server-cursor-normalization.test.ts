import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, agentHookServer, _internals } from './server'
import { createHookListenerState, normalizeHookPayload } from '../../shared/agent-hook-listener'
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
  it('recognizes Cursor beforeSubmitPrompt delivered through the Claude compatibility route', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'beforeSubmitPrompt',
        cursor_version: '2026.08.11-e8db854',
        prompt: 'add a README'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.prompt).toBe('add a README')
    expect(result?.hasExplicitPrompt).toBe(true)
    expect(result?.source).toBe('claude')
  })

  it('does not infer Cursor from a camelCase Claude-route event without cursor_version', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'keep the route fail closed'
      }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('does not create a working row for Cursor sessionStart on the Claude compatibility route', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'sessionStart',
        cursor_version: '2026.08.11-e8db854'
      }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('recognizes Cursor stop delivered through the Claude compatibility route', () => {
    _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'beforeSubmitPrompt',
        cursor_version: '2026.08.11-e8db854',
        prompt: 'add tests'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'stop',
        cursor_version: '2026.08.11-e8db854',
        status: 'completed'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('cursor')
    expect(result?.payload.prompt).toBe('add tests')
  })

  it('does not reroute a genuine Claude event that happens to carry cursor_version', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        cursor_version: '2026.08.11-e8db854',
        prompt: 'keep Claude semantics'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('claude')
    expect(result?.payload.prompt).toBe('keep Claude semantics')
  })

  it.each([
    ['compatibility first', ['/hook/claude', '/hook/cursor']],
    ['native first', ['/hook/cursor', '/hook/claude']]
  ] as const)(
    'dedupes one Cursor event delivered through both routes (%s)',
    async (_label, paths) => {
      const server = new AgentHookServer()
      const statusListener = vi.fn()
      server.subscribeEnrichedStatus(statusListener)
      await server.start({ env: 'production' })
      try {
        const env = server.buildPtyEnv()
        const body = JSON.stringify(
          buildBody({
            hook_event_name: 'beforeSubmitPrompt',
            cursor_version: '2026.08.11-e8db854',
            conversation_id: 'conversation-1',
            generation_id: 'generation-1',
            prompt: 'add a README'
          })
        )
        for (const pathname of paths) {
          const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${pathname}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body
          })
          expect(response.status).toBe(204)
        }

        expect(statusListener).toHaveBeenCalledTimes(1)
        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            state: 'working',
            agentType: 'cursor',
            prompt: 'add a README'
          })
        ])
      } finally {
        server.stop()
      }
    }
  )

  it('dedupes cross-route Cursor payloads whose object keys arrive in different orders', () => {
    const state = createHookListenerState()
    const compatibility = normalizeHookPayload(
      state,
      'claude',
      buildBody({
        hook_event_name: 'beforeSubmitPrompt',
        cursor_version: '2026.08.11-e8db854',
        conversation_id: 'conversation-1',
        generation_id: 'generation-1',
        prompt: 'add a README'
      }),
      'production'
    )
    const native = normalizeHookPayload(
      state,
      'cursor',
      buildBody({
        prompt: 'add a README',
        generation_id: 'generation-1',
        conversation_id: 'conversation-1',
        cursor_version: '2026.08.11-e8db854',
        hook_event_name: 'beforeSubmitPrompt'
      }),
      'production'
    )

    expect(compatibility?.payload.agentType).toBe('cursor')
    expect(native).toBeNull()
  })

  it('does not suppress repeated Cursor deliveries from the same route', () => {
    const state = createHookListenerState()
    const body = buildBody({
      hook_event_name: 'beforeSubmitPrompt',
      cursor_version: '2026.08.11-e8db854',
      generation_id: 'generation-1',
      prompt: 'add a README'
    })

    expect(normalizeHookPayload(state, 'cursor', body, 'production')).not.toBeNull()
    expect(normalizeHookPayload(state, 'cursor', body, 'production')).not.toBeNull()
  })

  it('accepts a same-route retry after consuming a cross-route duplicate pair', () => {
    const state = createHookListenerState()
    const body = buildBody({
      hook_event_name: 'beforeSubmitPrompt',
      cursor_version: '2026.08.11-e8db854',
      generation_id: 'generation-1',
      prompt: 'add a README'
    })

    expect(normalizeHookPayload(state, 'claude', body, 'production')).not.toBeNull()
    expect(normalizeHookPayload(state, 'cursor', body, 'production')).toBeNull()
    expect(normalizeHookPayload(state, 'cursor', body, 'production')).not.toBeNull()
  })

  it('bounds the Cursor dual-delivery fingerprint cache', () => {
    const state = createHookListenerState()
    for (let index = 0; index < 300; index += 1) {
      normalizeHookPayload(
        state,
        'cursor',
        buildBody({
          hook_event_name: 'beforeSubmitPrompt',
          cursor_version: '2026.08.11-e8db854',
          generation_id: `generation-${index}`,
          prompt: `prompt ${index}`
        }),
        'production'
      )
    }
    expect(state.cursorHookDeliveryByFingerprint.size).toBe(256)
  })

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
