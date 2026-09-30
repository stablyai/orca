import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const TURN_PROMPT_ID = '00000000-0000-4000-8000-000000000001'
const ALPHA = { tool_name: 'Bash', tool_input: { command: 'chmod 644 alpha.txt' } }

// The prompt Claude 2.1.284 fired when a background shell ended mid-turn (capture r1-s8), with its
// ids and paths scrubbed. It arrived as a UserPromptSubmit reusing the running turn's prompt_id.
const TASK_NOTIFICATION = {
  hook_event_name: 'UserPromptSubmit',
  prompt_id: TURN_PROMPT_ID,
  prompt:
    '<task-notification>\n<task-id>b0000000a</task-id>\n' +
    '<tool-use-id>toolu_00000000000000000000000A</tool-use-id>\n' +
    '<output-file>/private/tmp/claude-501/-work/tasks/b0000000a.output</output-file>\n' +
    '<status>completed</status>\n' +
    '<summary>Background command "sleep 3.01" completed (exit code 0)</summary>\n' +
    '</task-notification>'
}

// A harness-injected UserPromptSubmit lands inside the running turn: it is not the user answering or
// abandoning a prompt, so it must neither clear the card nor restart the wait (a second alert).
// Hook bodies are hand-built to the captured shape; only the notification text is real.
describe('a Claude prompt injected while a permission is outstanding', () => {
  let server: AgentHookServer
  let pushed: { state: string; stateStartedAt?: number; toolInput?: string; prompt: string }[]

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    pushed = []
    server.subscribeEnrichedStatus((enriched) => {
      pushed.push({
        state: enriched.payload.state,
        stateStartedAt: enriched.stateStartedAt,
        toolInput: enriched.payload.toolInput,
        prompt: enriched.payload.prompt
      })
    })
  })

  afterEach(() => {
    server.stop()
  })

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    postHookEvent(server, buildBody({ prompt_id: TURN_PROMPT_ID, ...payload }))

  const row = () => server.getStatusSnapshot()[0]

  function expectOneUnbrokenWait(toolInput: string): void {
    const during = pushed.slice(pushed.findIndex((payload) => payload.state === 'waiting'))
    expect(during.length).toBeGreaterThan(1)
    expect(during.every((payload) => payload.state === 'waiting')).toBe(true)
    expect(new Set(during.map((payload) => payload.stateStartedAt)).size).toBe(1)
    expect(during.every((payload) => payload.toolInput === toolInput)).toBe(true)
    expect(during.every((payload) => payload.prompt === 'set permissions')).toBe(true)
  }

  it('keeps the main agent prompt and its wait through a task notification', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post(TASK_NOTIFICATION)

    expect(row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    expectOneUnbrokenWait('chmod 644 alpha.txt')

    // The prompt kept its announced id, so its own completion still releases it.
    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    expect(row()).toMatchObject({ state: 'working', agentType: 'claude' })
  })

  it('keeps a child prompt and its wait through a task notification and a teammate message', async () => {
    const child = { agent_id: 'agent-child-a', agent_type: 'general-purpose' }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({ hook_event_name: 'PreToolUse', ...child, ...ALPHA, tool_use_id: 'toolu-child' })
    await post({ hook_event_name: 'PermissionRequest', ...child, ...ALPHA })
    await post(TASK_NOTIFICATION)
    await post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<teammate-message teammate_id="researcher">status?</teammate-message>'
    })

    expect(row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    expectOneUnbrokenWait('chmod 644 alpha.txt')

    await post({ hook_event_name: 'PostToolUse', ...child, ...ALPHA, tool_use_id: 'toolu-child' })
    expect(row()).toMatchObject({ state: 'working', agentType: 'claude' })
  })

  it('still releases the prompt when the user types a new one', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: '00000000-0000-4000-8000-000000000002',
      prompt: 'never mind, do something else'
    })

    expect(row()).toMatchObject({ state: 'working', prompt: 'never mind, do something else' })
    expect(row()?.toolName).toBeUndefined()
    // Nothing of the old turn survives: the swept prompt's completion is plain work.
    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    expect(row()).toMatchObject({ state: 'working' })
  })

  it('still moves past the main agent question, whose answer emits no hook', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which file?', options: [] }] },
      tool_use_id: 'toolu-question'
    })
    expect(row()).toMatchObject({ state: 'waiting' })

    await post(TASK_NOTIFICATION)
    expect(row()).toMatchObject({ state: 'working', prompt: 'set permissions' })
  })
})
