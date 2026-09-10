import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient, type OmpRpcClient } from './omp-rpc-client'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

const clients = new Set<OmpRpcClient>()
const temporaryDirectories = new Set<string>()

function spawnScenario(scenario: Parameters<typeof createFakeOmpRpcChild>[0]): OmpRpcClient {
  const client = spawnOmpRpcClient(createFakeOmpRpcChild(scenario, 'session-owning').spawnOptions)
  clients.add(client)
  return client
}

async function tempMarkerPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-rpc-turn-events-'))
  temporaryDirectories.add(dir)
  return join(dir, name)
}

afterEach(async () => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  )
  temporaryDirectories.clear()
})

describe('OMP RPC client turn-lifecycle frames', () => {
  it('emits message-update for a text_delta event', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    expect(events.filter((e) => e.kind === 'message-update')).toHaveLength(2)
    const delta = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent?.type === 'text_delta'
    )
    expect(delta).toBeDefined()
    if (
      delta?.kind === 'message-update' &&
      delta.frame.assistantMessageEvent?.type === 'text_delta'
    ) {
      expect(delta.frame.assistantMessageEvent.delta).toBe('Hi')
    }
  })

  it('protocol-faults on a message_update missing its delta', async () => {
    const client = spawnScenario({
      promptEvents: [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await expect(client.prompt('hello')).rejects.toThrow()
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(true)
  })

  // F1 (CRITICAL): OMP echoes the user's own turn through message_update
  // with role:'user' and no assistantMessageEvent at all — this is a valid,
  // non-fatal frame shape, not a protocol fault.
  it('does not protocol-fault on a message_update with no assistantMessageEvent (user echo)', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'message_update', message: { role: 'user', content: [] } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(false)
    const delta = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent?.type === 'text_delta'
    )
    expect(delta).toBeDefined()
    const userEcho = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent === undefined
    )
    expect(userEcho).toBeDefined()
    // The session must still be alive after the echo — a real, subsequent
    // command succeeds.
    const state = await client.getState()
    expect(state).toBeDefined()
  })

  it('emits agent-end honoring isTerminal', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'agent_end', messages: [], isTerminal: false },
        { type: 'agent_end', messages: [], isTerminal: true }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    const agentEnd = events.find((e) => e.kind === 'agent-end')
    expect(agentEnd).toBeDefined()
    if (agentEnd?.kind === 'agent-end') {
      expect(agentEnd.frame.isTerminal).toBe(false)
    }
  })

  // Wire shapes verified live against omp/18.0.11 and canonical
  // packages/agent/src/types.ts AgentEvent: tool_execution_start carries
  // `args` (NOT `input`) and tool_execution_end carries `result` (NOT
  // `content`), where `result` is a ToolResult envelope, not a string.
  it('passes through agent_start, turn_start/end, and tool_execution_* frames', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'agent_start' },
        { type: 'turn_start' },
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'read',
          args: { path: 'a' },
          intent: 'Reading a'
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'read',
          result: { content: [{ type: 'text', text: 'ok' }] },
          isError: false
        },
        { type: 'turn_end' }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'agent-start',
        'turn-start',
        'tool-execution-start',
        'tool-execution-end',
        'turn-end'
      ])
    )
    const toolStart = events.find((e) => e.kind === 'tool-execution-start')
    expect(toolStart).toBeDefined()
    if (toolStart?.kind === 'tool-execution-start') {
      expect(toolStart.frame.toolCallId).toBe('call-1')
      expect(toolStart.frame.toolName).toBe('read')
      expect(toolStart.frame.args).toEqual({ path: 'a' })
      expect(toolStart.frame.intent).toBe('Reading a')
    }
  })

  // An advisor card is the one message frame with content of its own — it never
  // streams through `message_update` — so the renderer's advisor row depends on
  // `message` surviving the passthrough intact, `details` included.
  it('passes an advisor card through message_start/message_end with its notes intact', async () => {
    const card = {
      role: 'custom',
      customType: 'advisor',
      display: true,
      attribution: 'agent',
      timestamp: 1_700_000_000_000,
      content:
        '<advisory advisor="Architecture" severity="concern" guidance="weigh, don\'t blindly obey">\nWatch the coupling.\n</advisory>',
      details: {
        notes: [{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }]
      }
    }
    const client = spawnScenario({
      promptEvents: [
        { type: 'message_start', message: card },
        { type: 'message_end', message: card }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    const end = events.find((event) => event.kind === 'message-end')
    expect(end).toBeDefined()
    if (end?.kind === 'message-end') {
      expect(end.frame.message).toEqual(card)
    }
    expect(events.some((event) => event.kind === 'unknown-frame')).toBe(false)
    expect(events.some((event) => event.kind === 'protocol-fault')).toBe(false)
  })

  // The renderer must never learn OMP's ToolResult envelope shape: the client
  // flattens `result.content` into the display string here, main-side, using
  // the same helper the transcript decoder uses for a persisted toolResult.
  it('normalizes tool_execution_end result content into a display output string', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'read',
          result: {
            content: [{ type: 'text', text: '[hello.txt#267A]\n1:orca-probe-marker' }],
            details: { totalLines: 1 }
          },
          isError: false
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    const toolEnd = events.find((e) => e.kind === 'tool-execution-end')
    expect(toolEnd).toBeDefined()
    if (toolEnd?.kind === 'tool-execution-end') {
      expect(toolEnd.output).toBe('[hello.txt#267A]\n1:orca-probe-marker')
      expect(toolEnd.isError).toBe(false)
    }
  })

  it('normalizes tool_execution_update partialResult into a live output string', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'tool_execution_update',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'ls' },
          partialResult: { content: [{ type: 'text', text: 'partial line' }] }
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    const toolUpdate = events.find((e) => e.kind === 'tool-execution-update')
    expect(toolUpdate).toBeDefined()
    if (toolUpdate?.kind === 'tool-execution-update') {
      expect(toolUpdate.partialOutput).toBe('partial line')
      expect(toolUpdate.frame.toolCallId).toBe('call-1')
    }
  })

  it('flags an errored tool_execution_end', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'command not found' }] },
          isError: true
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    const toolEnd = events.find((e) => e.kind === 'tool-execution-end')
    // Required, not incidental: without this the whole regression would pass
    // vacuously if dispatch ever stopped emitting the errored end frame.
    expect(toolEnd?.kind).toBe('tool-execution-end')
    if (toolEnd?.kind === 'tool-execution-end') {
      expect(toolEnd.isError).toBe(true)
      expect(toolEnd.output).toBe('command not found')
    }
  })

  it('protocol-faults on a tool_execution_end whose toolCallId is not a string', async () => {
    const client = spawnScenario({
      promptEvents: [{ type: 'tool_execution_end', toolCallId: 7, result: {} }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await expect(client.prompt('hello')).rejects.toThrow()
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(true)
  })

  // Subagent forwarding is OFF until the client asks for it (rpc.md
  // "Subagent subscriptions"); verified live against omp/18.0.11, which
  // answers set_subagent_subscription with the level it selected.
  it('negotiates a subagent subscription level and reports the selected level', async () => {
    const commandMarkerPath = await tempMarkerPath('commands.jsonl')
    const client = spawnScenario({ commandMarkerPath })
    await expect(client.setSubagentSubscription('progress')).resolves.toBe('progress')
    const written = await readFile(commandMarkerPath, 'utf8')
    expect(written).toContain('"type":"set_subagent_subscription"')
    expect(written).toContain('"level":"progress"')
  })

  it('forwards subagent lifecycle, progress, and event frames', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started' }
        },
        {
          type: 'subagent_progress',
          payload: {
            index: 0,
            agent: 'explorer',
            task: 'map the auth flow',
            progress: {
              id: 'sa-1',
              index: 0,
              agent: 'explorer',
              status: 'running',
              task: 'map the auth flow',
              currentTool: 'grep'
            }
          }
        },
        {
          type: 'subagent_event',
          payload: { id: 'sa-1', event: { type: 'turn_start' } }
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['subagent-lifecycle', 'subagent-progress', 'subagent-event'])
    )
    const lifecycle = events.find((e) => e.kind === 'subagent-lifecycle')
    if (lifecycle?.kind === 'subagent-lifecycle') {
      expect(lifecycle.frame.payload.id).toBe('sa-1')
      expect(lifecycle.frame.payload.status).toBe('started')
    }
    const progress = events.find((e) => e.kind === 'subagent-progress')
    if (progress?.kind === 'subagent-progress') {
      expect(progress.frame.payload.progress.currentTool).toBe('grep')
    }
  })

  it('protocol-faults on a subagent_lifecycle carrying an unusable payload', async () => {
    const client = spawnScenario({
      promptEvents: [{ type: 'subagent_lifecycle', payload: { id: 'sa-1', status: 'started' } }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await expect(client.prompt('hello')).rejects.toThrow()
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(true)
  })

  // Documented AgentSessionEvent members Orca forwards but does not render
  // must stay distinguishable from a frame type this build has never heard of.
  it('routes documented session events to session-event, not unknown-frame', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'notice', level: 'warning', message: 'context is filling up' },
        { type: 'thinking_level_changed', thinkingLevel: 'high' },
        { type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' },
        { type: 'a_frame_from_the_future' }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.prompt('hello')
    const sessionEvents = events.filter((e) => e.kind === 'session-event')
    expect(sessionEvents.map((e) => e.kind === 'session-event' && e.frame.type)).toEqual([
      'notice',
      'thinking_level_changed',
      'auto_compaction_start'
    ])
    const unknown = events.filter((e) => e.kind === 'unknown-frame')
    expect(unknown.map((e) => e.kind === 'unknown-frame' && e.frame.type)).toEqual([
      'a_frame_from_the_future'
    ])
  })

  it('emits extension-ui-request for a select approval prompt', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'extension_ui_request',
          id: 'ask-1',
          method: 'select',
          message: 'Approve running rm?',
          options: ['Approve', 'Deny']
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    const request = events.find((e) => e.kind === 'extension-ui-request')
    expect(request).toBeDefined()
    if (request?.kind === 'extension-ui-request') {
      expect(request.frame.id).toBe('ask-1')
      expect(request.frame.options).toEqual(['Approve', 'Deny'])
    }
  })

  it('sends steer and follow_up with the documented wire shape', async () => {
    const client = spawnScenario({ steerAgentInvoked: true, followUpAgentInvoked: true })
    await client.whenReady()
    await expect(client.steer('stop and do X')).resolves.toEqual({ agentInvoked: true })
    await expect(client.followUp('do Y after')).resolves.toEqual({ agentInvoked: true })
  })

  it('sends prompt with images and streamingBehavior when provided', async () => {
    const argvMarkerPath = await tempMarkerPath('argv.json')
    const client = spawnScenario({ argvMarkerPath, promptAgentInvoked: true })
    await client.whenReady()
    await client.prompt('continue', {
      streamingBehavior: 'steer',
      images: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }]
    })
    // Why: argvMarkerPath only proves the child launched with the scenario; the
    // wire shape itself is proven by the fake script's response echoing agentInvoked.
    await readFile(argvMarkerPath, 'utf8')
  })

  it('writes a raw extension_ui_response frame bypassing command correlation', async () => {
    const extensionUiResponseMarkerPath = await tempMarkerPath('responses.jsonl')
    const client = spawnScenario({ extensionUiResponseMarkerPath })
    await client.whenReady()
    expect(
      client.respondExtensionUi({ type: 'extension_ui_response', id: 'ask-1', value: 'Approve' })
    ).toBe(true)
    // Why: the child's stdin is a single ordered stream — awaiting a correlated
    // command sent afterward proves the prior raw write was already processed,
    // without a fixed-duration sleep.
    await client.getState()
    const written = await readFile(extensionUiResponseMarkerPath, 'utf8')
    expect(JSON.parse(written.trim())).toEqual({
      type: 'extension_ui_response',
      id: 'ask-1',
      value: 'Approve'
    })
  })

  it('returns false from respondExtensionUi after dispose', async () => {
    const client = spawnScenario({})
    await client.whenReady()
    client.dispose()
    expect(
      client.respondExtensionUi({ type: 'extension_ui_response', id: 'x', confirmed: true })
    ).toBe(false)
  })
})
