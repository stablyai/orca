import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'
import { setPluginHookRunner } from '../../../../plugins/hooks/plugin-hook-dispatch'
import {
  AGENT_TOOL_DECISION_HEADER,
  CLAUDE_PRE_TOOL_USE_DECISION
} from '../../../tool-events/agent-tool-plugin-hooks'
import {
  AgentTransitionDetector,
  type AgentPaneChange
} from '../../../observations/agent-transition-detector'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const PLUGIN_CALL = {
  tool_name: 'mcp__plugin__sync',
  tool_input: { path: 'notes.md' },
  tool_use_id: 'toolu_plugin_0a1b'
}

let server: AgentHookServer
let hookUrl: string
let hookToken: string
let pluginHooksRun: string[]
let heldEvents: AgentHookEventPayload[]
let admittedHolds: number
let paneChanges: AgentPaneChange[]

beforeEach(async () => {
  _internals.resetCachesForTests()
  pluginHooksRun = []
  heldEvents = []
  admittedHolds = 0
  paneChanges = []
  setPluginHookRunner({
    wants: () => true,
    run: async (event, payload) => {
      pluginHooksRun.push(event)
      return event === 'agent.tool.before'
        ? { kind: 'deny', pluginKey: 'gate', reason: 'blocked' }
        : { kind: 'continue', payload }
    }
  })
  server = new AgentHookServer()
  server.setClaudePermissionHolds({
    admit: () => {
      admittedHolds += 1
      return false
    },
    observe: (event) => heldEvents.push(event)
  })
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    subscribeToPtyExit: () => () => {},
    now: Date.now
  })
  detector.subscribe((change) => paneChanges.push(change))
  detector.attach(server)
  await server.start({ env: 'production' })
  const env = server.buildPtyEnv()
  hookUrl = `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`
  hookToken = env.ORCA_AGENT_HOOK_TOKEN
})

afterEach(() => {
  server.stop()
  setPluginHookRunner(null)
  vi.restoreAllMocks()
})

async function post(payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const response = await fetch(hookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': hookToken,
      [AGENT_TOOL_DECISION_HEADER]: CLAUDE_PRE_TOOL_USE_DECISION
    },
    body: JSON.stringify(buildBody(payload))
  })
  return { status: response.status, body: await response.text() }
}

function paneRow() {
  return server.getStatusSnapshot().find((row) => row.paneKey === PANE)
}

function movedTransitions(): (string | null)[] {
  return paneChanges.flatMap((change) => (change.kind === 'moved' ? [change.transition] : []))
}

async function expectPluginCallGatedAndObserved(): Promise<void> {
  const before = await post({ hook_event_name: 'PreToolUse', ...PLUGIN_CALL })
  expect(before.status).toBe(200)
  expect(JSON.parse(before.body)).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }
  })
  const after = await post({ hook_event_name: 'PostToolUse', ...PLUGIN_CALL, tool_response: {} })
  expect(after.status).toBe(204)
  expect(pluginHooksRun).toEqual(['agent.tool.before', 'agent.tool.after'])
  expect(heldEvents.at(-1)).toMatchObject({
    hookEventName: 'PostToolUse',
    toolUseId: PLUGIN_CALL.tool_use_id
  })
}

describe('Claude plugin-made tool calls at the hook server', () => {
  it('gates and reports a plugin call after Stop without reopening the finished turn', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    await post({ hook_event_name: 'Stop' })
    const finished = paneRow()
    expect(finished?.state).toBe('done')
    const transitionsAtStop = movedTransitions()
    expect(transitionsAtStop.at(-1)).toBe('turn-finished')

    await expectPluginCallGatedAndObserved()

    const row = paneRow()
    expect(row).toMatchObject({
      state: 'done',
      turnCompletedAt: finished?.turnCompletedAt,
      subagents: finished?.subagents
    })
    expect(row?.interrupted).toBeFalsy()
    expect(movedTransitions()).toEqual(transitionsAtStop)
    expect(admittedHolds).toBe(0)
  })

  it('gates and reports a plugin call mid-turn without changing the status', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'toolu_01Abc'
    })
    const working = paneRow()
    expect(working?.state).toBe('working')
    pluginHooksRun = []
    const transitionsMidTurn = movedTransitions()

    await expectPluginCallGatedAndObserved()

    expect(paneRow()).toMatchObject({
      state: 'working',
      toolName: working?.toolName,
      stateStartedAt: working?.stateStartedAt
    })
    expect(movedTransitions()).toEqual(transitionsMidTurn)
  })

  it('keeps a model permission prompt waiting through a plugin call and a parallel result', async () => {
    const read = {
      tool_name: 'Read',
      tool_input: { file_path: 'a.md' },
      tool_use_id: 'toolu_01Read'
    }
    const bash = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01Bash' }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    await post({ hook_event_name: 'PreToolUse', ...read })
    await post({ hook_event_name: 'PreToolUse', ...bash })
    await post({
      hook_event_name: 'PermissionRequest',
      tool_name: bash.tool_name,
      tool_input: bash.tool_input
    })
    expect(paneRow()?.state).toBe('waiting')
    pluginHooksRun = []

    await expectPluginCallGatedAndObserved()
    expect(paneRow()?.state).toBe('waiting')

    await post({ hook_event_name: 'PostToolUse', ...read, tool_response: {} })
    expect(paneRow()?.state).toBe('waiting')
  })
})
