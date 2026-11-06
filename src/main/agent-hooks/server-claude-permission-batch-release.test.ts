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

  it('ends a wait for one of several parallel calls whose hooks interleave', async () => {
    for (const events of [capture.leadParallelReads, capture.childParallelReads]) {
      const states = await replay(events)
      const batchEnd = events.findIndex((event) => event.hook_event_name === 'PostToolBatch')
      expect(states[batchEnd - 1]).not.toBe('PostToolBatch:working')
      expect(states[batchEnd]).toBe('PostToolBatch:working')
    }
  })

  it("keeps a subagent's prompt after its sibling call finishes and the lead works on", async () => {
    const outside = { file_path: '/private/tmp/outside-x' }
    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', ...child },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/dev/project/z.ts' },
        tool_use_id: 'toolu-z',
        ...child
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: outside,
        tool_use_id: 'toolu-x',
        ...child
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: outside, ...child },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/dev/project/z.ts' },
        tool_use_id: 'toolu-z',
        ...child
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu-ls'
      }
    ])
    expect(states.slice(-3)).toEqual([
      'PermissionRequest:waiting',
      'PostToolUse:waiting',
      'PreToolUse:waiting'
    ])
  })

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

  it('keeps a subagent prompt while the lead works and another subagent request ends', async () => {
    const childA = { agent_id: 'agent-a', agent_type: 'general-purpose' }
    const childB = { agent_id: 'agent-b', agent_type: 'general-purpose' }
    const commandA = { command: 'touch /private/tmp/orca-permcap-a' }
    const commandB = { command: 'touch /private/tmp/orca-permcap-b' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
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
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu-ls'
      },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: commandB, tool_use_id: 'toolu-b' }],
        ...childB
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu-ls'
      }
    ])
    expect(states.slice(-2)).toEqual(['PostToolBatch:waiting', 'PostToolUse:waiting'])
  })

  it("ends a subagent's self-denied wait after an earlier subagent stopped with its prompt open", async () => {
    const childA = { agent_id: 'agent-a', agent_type: 'general-purpose' }
    const childB = { agent_id: 'agent-b', agent_type: 'general-purpose' }
    const commandA = { command: 'touch /private/tmp/orca-permcap-a' }
    const commandB = { command: 'touch /private/tmp/orca-permcap-b' }
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', ...childA },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: commandA,
        tool_use_id: 'toolu-a',
        ...childA
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: commandA, ...childA },
      { hook_event_name: 'SubagentStop', ...childA },
      { hook_event_name: 'SubagentStart', ...childB },
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
    expect(states.at(-1)).toBe('PostToolBatch:working')
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

  it("keeps the lead's open prompt however many subagent calls follow it", async () => {
    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const leadCommand = { command: 'touch /private/tmp/orca-permcap-lead' }
    const reads = Array.from({ length: 40 }, (_, index) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: `/tmp/file-${index}` },
      tool_use_id: `toolu-read-${index}`,
      ...child
    }))
    const last = reads.at(-1)!
    const states = await replay([
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: leadCommand,
        tool_use_id: 'toolu-lead'
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: leadCommand },
      ...reads,
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: last.tool_input,
        ...child
      },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: reads.map(({ tool_name, tool_input, tool_use_id }) => ({
          tool_name,
          tool_input,
          tool_use_id
        })),
        ...child
      }
    ])
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

  it("ends a subagent's self-denied wait when the listener has no earlier record of the lead", async () => {
    const child = { agent_id: 'agent-child', agent_type: 'general-purpose' }
    const command = { command: 'touch /private/tmp/orca-permcap-fresh' }
    const states = await replay([
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: command,
        tool_use_id: 'toolu-x',
        ...child
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: command, ...child },
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu-x' }],
        ...child
      }
    ])
    expect(states.slice(-2)).toEqual(['PermissionRequest:waiting', 'PostToolBatch:working'])
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

  describe('with a wait Orca cannot identify', () => {
    const childA = { agent_id: 'agent-a', agent_type: 'general-purpose' }
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

    it('ends a wait whose call was never seen when the user approves the request', async () => {
      const command = { command: 'touch /private/tmp/orca-permcap-unseen' }
      const request = {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: command,
        ...childA
      }
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childA },
        request,
        request,
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: command,
          tool_use_id: 'toolu-unseen',
          ...childA
        }
      ])
      expect(states.slice(-2)).toEqual(['PermissionRequest:waiting', 'PostToolUse:working'])
    })

    it("keeps a request whose call was never seen after the same agent's matching tool finishes", async () => {
      const readA = { file_path: '/tmp/orca-permcap-a' }
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childA },
        { hook_event_name: 'SubagentStart', ...childB },
        { hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: readA, ...childA },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/orca-permcap-sibling' },
          tool_use_id: 'toolu-sibling',
          ...childA
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/orca-permcap-sibling' },
          tool_use_id: 'toolu-sibling',
          ...childA
        },
        {
          hook_event_name: 'PostToolBatch',
          tool_calls: [
            {
              tool_name: 'Read',
              tool_input: { file_path: '/tmp/orca-permcap-sibling' },
              tool_use_id: 'toolu-sibling'
            }
          ],
          ...childA
        },
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

    it("keeps the lead's open prompt when a task notification arrives before a subagent's request ends", async () => {
      const states = await replay([
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', ...childB },
        ...leadRequest,
        {
          hook_event_name: 'UserPromptSubmit',
          prompt:
            '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'
        },
        ...childBDenial
      ])
      expect(states.at(-1)).toBe('PostToolBatch:waiting')
    })

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
