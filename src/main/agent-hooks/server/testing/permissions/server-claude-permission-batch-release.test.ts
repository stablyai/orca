import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
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
  it("keeps the pane waiting when a subagent's request ends while the lead's own prompt is open", async () => {
    const leadCommand = { command: 'touch /private/tmp/orca-permcap-lead' }
    const childCommand = { command: 'touch /private/tmp/orca-permcap-child' }
    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: leadCommand,
        tool_use_id: 'toolu-lead'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: leadCommand },
      { hook_event_name: 'SubagentStart', ...child },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: childCommand,
        tool_use_id: 'toolu-child',
        ...child
      },
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: childCommand,
        ...child
      },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: childCommand, tool_use_id: 'toolu-child' }],
        ...child
      }
    ])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it("keeps the pane waiting when one subagent's request ends while another's prompt is open", async () => {
    const childA = { agent_id: 'agent-a', agent_type: 'general-purpose' }
    const childB = { agent_id: 'agent-b', agent_type: 'general-purpose' }
    const commandA = { command: 'touch /private/tmp/orca-permcap-a' }
    const commandB = { command: 'touch /private/tmp/orca-permcap-b' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', ...childA },
      { hook_event_name: 'SubagentStart', ...childB },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: commandA,
        tool_use_id: 'toolu-a',
        ...childA
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: commandA, ...childA },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: commandB,
        tool_use_id: 'toolu-b',
        ...childB
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: commandB, ...childB },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: commandB, tool_use_id: 'toolu-b' }],
        ...childB
      }
    ])
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it("keeps the pane waiting on the lead's unanswered question when a subagent's request ends", async () => {
    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const command = { command: 'touch /private/tmp/orca-permcap-q' }
    const question = { questions: [{ question: 'Which file?', options: [{ label: 'a' }] }] }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: question,
        tool_use_id: 'toolu-q'
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-b',
        ...child
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command, ...child },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu-b' }],
        ...child
      }
    ])
    // The card shows the newest prompt, as on main; showing each open prompt's card is the follow-up.
    expect(states.at(-1)).toBe('PostToolBatch:waiting')
  })

  it("keeps an open MCP dialog when a subagent's self-denied request ends", async () => {
    const child = { agent_id: 'agent-a', agent_type: 'general-purpose' }
    const command = { command: 'touch /private/tmp/orca-permcap-mcp' }
    const dialog = { mcp_server_name: 'srv', elicitation_id: 'elicit-1' }
    const childRequest = [
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-a',
        ...child
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command, ...child },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu-a' }],
        ...child
      }
    ]
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', ...child },
      { hook_event_name: 'Elicitation', mode: 'form', ...dialog },
      ...childRequest,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu-ls'
      }
    ])
    expect(states.slice(-2)).toEqual(['PostToolBatch:waiting', 'PreToolUse:waiting'])
  })

  it("keeps a request whose call was never seen when another subagent's request ends", async () => {
    const childA = { agent_id: 'agent-a', agent_type: 'general-purpose' }
    const childB = { agent_id: 'agent-b', agent_type: 'general-purpose' }
    const commandB = { command: 'touch /private/tmp/orca-permcap-b' }
    const states = await replay([
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch /private/tmp/orca-permcap-a' },
        ...childA
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: commandB,
        tool_use_id: 'toolu-b',
        ...childB
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: commandB, ...childB },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: commandB, tool_use_id: 'toolu-b' }],
        ...childB
      }
    ])
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

  describe('with a wait Orca cannot identify', () => {
    const childB = { agent_id: 'agent-b', agent_type: 'general-purpose' }
    const commandB = { command: 'touch /private/tmp/orca-permcap-b' }
    const childBDenial = [
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: commandB,
        tool_use_id: 'toolu-b',
        ...childB
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: commandB, ...childB },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: commandB, tool_use_id: 'toolu-b' }],
        ...childB
      }
    ]

    it('keeps an unanswered MCP dialog when a result without an id arrives twice', async () => {
      const dialog = { hook_event_name: 'Elicitation', mode: 'form', mcp_server_name: 'srv' }
      const result = { hook_event_name: 'ElicitationResult', mcp_server_name: 'srv' }
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childB },
        dialog,
        dialog,
        result,
        result,
        ...childBDenial
      ])
      expect(states.at(-1)).toBe('PostToolBatch:waiting')
    })

    it("keeps one server's MCP dialog when another server answers a dialog with the same id", async () => {
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childB },
        { hook_event_name: 'Elicitation', mcp_server_name: 'one', elicitation_id: 'e-1' },
        { hook_event_name: 'Elicitation', mcp_server_name: 'two', elicitation_id: 'e-1' },
        { hook_event_name: 'ElicitationResult', mcp_server_name: 'one', elicitation_id: 'e-1' },
        ...childBDenial
      ])
      expect(states.at(-1)).toBe('PostToolBatch:waiting')
    })

    const leadCommand = { command: 'touch /private/tmp/orca-permcap-lead' }
    const leadRequest = [
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: leadCommand,
        tool_use_id: 'toolu-lead'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: leadCommand }
    ]

    it("keeps the lead's open prompt when another agent reports a result under the same id", async () => {
      const childC = { agent_id: 'agent-c', agent_type: 'general-purpose' }
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childB },
        { hook_event_name: 'SubagentStart', ...childC },
        ...leadRequest,
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: leadCommand,
          tool_use_id: 'toolu-lead',
          ...childC
        },
        ...childBDenial
      ])
      expect(states.at(-1)).toBe('PostToolBatch:waiting')
    })
  })
})
