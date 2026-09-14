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

describe('Droid hook normalization', () => {
  it('UserPromptSubmit maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'ship this fix' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('droid')
    expect(result?.payload.prompt).toBe('ship this fix')
  })

  it('Notification maps permission prompts to waiting and idle prompts to done', () => {
    const waiting = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid needs your permission to use Execute'
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )
    expect(done?.payload.state).toBe('done')

    const ignored = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Task completed successfully'
      }),
      'production'
    )
    expect(ignored).toBeNull()
  })

  it('Notification preserves the cached user prompt instead of using status text as prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )

    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('write tests')
    expect(done?.hasExplicitPrompt).toBe(false)
  })

  it('Notification ignores confirmation status text rather than treating it as permission', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Confirmed configuration loaded'
      }),
      'production'
    )

    expect(result).toBeNull()
  })

  it('SubagentStop does not mark Droid done for mission progress', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'SubagentStop',
        last_assistant_message: '# Completed Wrote the requested validation assertions'
      }),
      'production'
    )

    expect(result).toBeNull()
  })

  it('PreToolUse maps to working and surfaces the tool name and input preview', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/example.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/tmp/example.ts')
  })

  it('PreToolUse falls back to the `name` and `input` fields when tool_name/tool_input are absent', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        name: 'Bash',
        input: { command: 'pnpm typecheck' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('Bash')
    expect(result?.payload.toolInput).toBe('pnpm typecheck')
  })

  it('PreToolUse AskUser maps to waiting for human input', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUser',
        tool_input: { question: 'Which permission-requiring action should I perform?' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('AskUser')
  })

  it('PreToolUse high-risk Execute maps to waiting for approval', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: {
          command: 'echo "test modification" >> ~/.claude/config.json',
          riskLevel: 'high',
          riskLevelReason: "This command modifies the user's Claude Code config file."
        }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('Execute')
    expect(result?.payload.toolInput).toBe('echo "test modification" >> ~/.claude/config.json')
  })

  it('PermissionRequest maps low-impact Edit approvals to waiting and carries cached tool', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'edit it to none' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/Users/thebr/.claude/settings.json',
          old_str: '"preferredNotifChannel": "terminal_bell"',
          new_str: '"preferredNotifChannel": "none"'
        }
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.prompt).toBe('edit it to none')
    expect(result?.payload.toolName).toBe('Edit')
    expect(result?.payload.toolInput).toBe('/Users/thebr/.claude/settings.json')
  })

  it('SessionStart resets turn caches without marking Droid working', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'old prompt' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/old.ts' }
      }),
      'production'
    )

    const sessionStart = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(sessionStart).toBeNull()

    const nextTool = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: { command: 'pwd' }
      }),
      'production'
    )
    expect(nextTool?.payload.state).toBe('working')
    expect(nextTool?.payload.prompt).toBe('')
    expect(nextTool?.payload.toolName).toBe('Execute')
    expect(nextTool?.payload.toolInput).toBe('pwd')
  })

  it('SubagentStop does not close the primary session row', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'SubagentStop' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('Stop maps to done and preserves the cached prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )
    const stop = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('write tests')
  })
})
