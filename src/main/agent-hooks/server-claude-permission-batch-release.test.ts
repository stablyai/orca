import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import capture from '../claude/__fixtures__/claude-self-denied-permission-hooks.json'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

type HookEvent = Record<string, unknown>

async function replay(events: readonly HookEvent[]): Promise<string[]> {
  return (await replayToRow(events)).states
}

async function replayToRow(events: readonly HookEvent[]): Promise<{
  states: string[]
  row: ReturnType<AgentHookServer['getStatusSnapshot']>[number] | undefined
}> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const env = server.buildPtyEnv()
    const states: string[] = []
    for (const event of events) {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody(event))
      })
      expect(response.status).toBe(204)
      const row = server.getStatusSnapshot().find((status) => status.paneKey === PANE)
      states.push(`${String(event.hook_event_name)}:${row?.state}`)
    }
    return {
      states,
      row: server.getStatusSnapshot().find((status) => status.paneKey === PANE)
    }
  } finally {
    server.stop()
  }
}

describe('Claude permission wait that Claude denies itself', () => {
  it("ends the lead's wait when its tool batch ends", async () => {
    expect(await replay(capture.leadDenied)).toEqual([
      'SessionStart:done',
      'UserPromptSubmit:working',
      'PreToolUse:working',
      'PostToolUse:working',
      'PreToolUse:working',
      'PermissionRequest:waiting',
      'PostToolBatch:working',
      'PreToolUse:working',
      'PostToolUse:working',
      'PostToolBatch:working',
      'Stop:done',
      'SessionEnd:done'
    ])
  })

  it("ends a subagent's wait only when that subagent's batch ends", async () => {
    expect(await replay(capture.childDenied)).toEqual([
      'SessionStart:done',
      'UserPromptSubmit:working',
      'PreToolUse:working',
      'SubagentStart:working',
      'PreToolUse:working',
      'PermissionRequest:waiting',
      // A sibling call in the same batch must not clear the prompt.
      'PreToolUse:waiting',
      'PostToolUse:waiting',
      'PostToolBatch:working',
      'SubagentStop:working',
      'PostToolUse:working',
      'PostToolBatch:working',
      'Stop:done',
      'SessionEnd:done'
    ])
  })

  it("keeps the lead's wait when a background subagent's batch ends", async () => {
    const leadWait = capture.leadDenied.slice(
      0,
      capture.leadDenied.findIndex((event) => event.hook_event_name === 'PermissionRequest') + 1
    )
    const childBatchEnd = capture.childDenied.find(
      (event) => event.hook_event_name === 'PostToolBatch' && 'agent_id' in event
    )
    expect(childBatchEnd).toBeDefined()
    const states = await replay([...leadWait, childBatchEnd!])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it("keeps a background subagent's wait when the lead's batch ends", async () => {
    const childWait = capture.childDenied.slice(
      0,
      capture.childDenied.findIndex((event) => event.hook_event_name === 'PermissionRequest') + 1
    )
    const leadBatchEnd = capture.childDenied.find(
      (event) => event.hook_event_name === 'PostToolBatch' && !('agent_id' in event)
    )
    expect(leadBatchEnd).toBeDefined()
    const states = await replay([...childWait, leadBatchEnd!])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it('keeps a newer prompt when an earlier batch from the same agent arrives late', async () => {
    const command = { command: 'touch /private/tmp/orca-permcap-newer' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-newer'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [
          { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu-earlier' }
        ]
      }
    ])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it('keeps an open MCP dialog and a finished turn when a batch ends', async () => {
    const batch = {
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu-ls' }]
    }
    expect(
      (
        await replay([
          { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
          { hook_event_name: 'Elicitation', mcp_server_name: 'server', mode: 'form' },
          batch
        ])
      ).at(-1)
    ).toBe('PostToolBatch:waiting')
    expect(
      (
        await replay([
          { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
          { hook_event_name: 'Stop' },
          batch
        ])
      ).at(-1)
    ).toBe('PostToolBatch:done')
  })

  it('keeps a wait whose request it cannot name, and an unanswered question with its card', async () => {
    const batch = {
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu-ls' }]
    }
    expect(
      (
        await replay([
          { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
          {
            hook_event_name: 'PermissionRequest',
            tool_name: 'Bash',
            tool_input: { command: 'ls' }
          },
          batch
        ])
      ).at(-1)
    ).toBe('PostToolBatch:waiting')
    const question = { questions: [{ question: 'Which file?', options: [{ label: 'a' }] }] }
    const { states, row } = await replayToRow([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: question,
        tool_use_id: 'toolu-question'
      },
      batch
    ])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
    expect(row?.interactivePrompt).toContain('Which file?')
  })

  it('keeps an MCP dialog that follows a permission when the permission ends', async () => {
    const command = { command: 'touch /private/tmp/orca-permcap-dialog' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-touch'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command },
      { hook_event_name: 'Elicitation', mcp_server_name: 'server', mode: 'form' },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu-touch' }]
      }
    ])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it("does not reopen a finished turn when a subagent's batch arrives late", async () => {
    const childBatchEnd = capture.childDenied.find(
      (event) => event.hook_event_name === 'PostToolBatch' && 'agent_id' in event
    )
    const untilStop = capture.childDenied.slice(
      0,
      capture.childDenied.findIndex((event) => event.hook_event_name === 'Stop') + 1
    )
    expect((await replay([...untilStop, childBatchEnd!])).at(-1)).toBe('PostToolBatch:done')
  })

  it('settles the first request of a batch longer than the replay history bound', async () => {
    const command = { command: 'touch /private/tmp/orca-permcap-long' }
    const siblings = Array.from({ length: 20 }, (_, index) => ({
      tool_name: 'Read',
      tool_input: { file_path: `/tmp/file-${index}` },
      tool_use_id: `toolu-read-${index}`
    }))
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-first'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [
          { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu-first' },
          ...siblings
        ]
      }
    ])
    expect(states.at(-1)).toBe('PostToolBatch:working')
  })
})
