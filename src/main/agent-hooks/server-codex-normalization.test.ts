import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

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

describe('Codex hook normalization', () => {
  it('tracks nested subagents with their role, model, and lifecycle state', () => {
    const root = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Coordinate the review',
        model: 'gpt-5.4'
      }),
      'production'
    )
    expect(root?.payload.model).toBe('gpt-5.4')

    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'SubagentStart',
        session_id: 'child-session',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini'
      }),
      'production'
    )
    expect(started?.providerSession).toBeUndefined()
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: 'Coordinate the review',
      model: 'gpt-5.4',
      subagents: [
        {
          id: 'child-session',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
          state: 'working'
        }
      ]
    })

    const waiting = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')
    expect(waiting?.payload.subagents?.[0].state).toBe('waiting')

    const workingAgain = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(workingAgain?.payload.state).toBe('working')
    expect(workingAgain?.payload.subagents?.[0].state).toBe('working')

    const rootStop = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'Stop', model: 'gpt-5.4' }),
      'production'
    )
    expect(rootStop?.payload.state).toBe('done')
    expect(rootStop?.payload.subagents).toBeUndefined()

    const resumedChild = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pnpm test' }
      }),
      'production'
    )
    expect(resumedChild?.payload.state).toBe('working')
    expect(resumedChild?.payload.subagents?.[0]).toMatchObject({
      id: 'child-session',
      state: 'working'
    })

    const stopped = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'child-session' }),
      'production'
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.subagents).toBeUndefined()
  })

  it('Stop carries last_assistant_message into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Summary of what I did.'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('Summary of what I did.')
  })

  it('PreToolUse surfaces tool name + input preview and stays in working state', () => {
    // Why: Codex's PreToolUse fires for every tool call (not an approval), so map it to `working` not `waiting`; approvals flow through PermissionRequest.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git status', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('PermissionRequest maps to waiting and surfaces the pending tool input', () => {
    // Why: PermissionRequest must map to `waiting` (sidebar red dot); treating it like PreToolUse would leave the pane looking busy while blocked on the user.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'exec_command',
        tool_input: { cmd: 'rm -rf build', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe('codex')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('rm -rf build')
  })

  it('UserPromptSubmit does not extract tool fields even when the payload carries them', () => {
    // Why: UserPromptSubmit is a turn boundary; tool extraction is gated to Pre/PostToolUse so stray tool_name can't leak into the preview.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Hello',
        tool_name: 'Edit',
        tool_input: { file_path: '/ignored.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('SessionStart clears cached tool state from a prior session', () => {
    // Seed a Stop snapshot with an assistant message.
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Previous run finished'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('SessionStart clears the cached prompt from a prior session until a new prompt arrives', () => {
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'stale prompt'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('')
  })
})
