// A Claude subagent blocked on a permission request, replayed from a capture of the real CLI
// through the real adapter into the host's child records.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentChildWorkLiveness } from '../../shared/agent-status-child-work-liveness'
import { structuredAgentSessionAgentStatus } from '../../shared/structured-agent-session-agent-status'
import { producer } from './claude-child-work-producer-harness.test-fixture'
import {
  invokeCanUseTool,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from './claude-structured-session-test-support'

type CapturedEvent = { from: 'cli' | 'orca'; frame: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capturedScenario(name: string): CapturedEvent[] {
  const path = join(__dirname, '__fixtures__', 'claude-subagent-permission-frames.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const events = isRecord(parsed) && isRecord(parsed.scenarios) ? parsed.scenarios[name] : null
  if (!Array.isArray(events)) {
    throw new Error(`no captured scenario ${name}`)
  }
  return events.flatMap((event) =>
    isRecord(event) && (event.from === 'cli' || event.from === 'orca') && isRecord(event.frame)
      ? [{ from: event.from, frame: event.frame }]
      : []
  )
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Hands `canUseTool` exactly what the SDK hands it for this wire request. */
function requestFromWire(
  connection: FakeConnection,
  wire: Record<string, unknown>,
  options: { signal?: AbortSignal; withoutAgentId?: boolean } = {}
): void {
  const request = isRecord(wire.request) ? wire.request : {}
  const agentId = options.withoutAgentId ? '' : text(request.agent_id)
  invokeCanUseTool(
    connection,
    text(request.tool_name),
    text(wire.request_id),
    text(request.tool_use_id),
    {
      input: isRecord(request.input) ? request.input : {},
      ...(options.signal ? { signal: options.signal } : {}),
      ...(agentId ? { agentID: agentId } : {})
    }
  )
}

/** Replays one capture and returns the subagent's record state after each event, labelled. */
async function replay(name: string, options: { withoutAgentId?: boolean } = {}) {
  const harness = await producer()
  const { adapter, claude, send } = harness
  const connection = claude.connections[0]!
  const aborts = new Map<string, AbortController>()
  const timeline: string[] = []
  const subagent = () => harness.records().find((record) => record.kind === 'agent')
  for (const { from, frame } of capturedScenario(name)) {
    const request = isRecord(frame.request) ? frame.request : null
    const response = isRecord(frame.response) ? frame.response : null
    let label = text(frame.subtype) || text(frame.type)
    if (frame.type === 'control_request' && request?.subtype === 'can_use_tool') {
      const controller = new AbortController()
      aborts.set(text(frame.request_id), controller)
      requestFromWire(connection, frame, { ...options, signal: controller.signal })
      label = 'can_use_tool'
    } else if (frame.type === 'control_cancel_request') {
      aborts.get(text(frame.request_id))?.abort()
    } else if (from === 'orca' && frame.type === 'control_response' && response) {
      // Answered through the app's own path, as the pane's approval card answers it.
      const requestId = text(response.request_id)
      const behavior = isRecord(response.response) ? text(response.response.behavior) : ''
      adapter.bindPromptItemId('session-1', `item-${requestId}`, requestId)
      await adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: `item-${requestId}`,
        kind: 'approval',
        optionId: behavior === 'deny' ? 'deny' : 'allow',
        fence: 7,
        commit: async () => undefined
      })
      label = behavior
    } else if (from === 'orca') {
      // The interrupt itself changes nothing here; the CLI's cancel frame that follows does.
      label = text(request?.subtype)
    } else {
      send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    const record = subagent()
    timeline.push(`${label} -> ${record ? `${record.membership} ${record.state}` : 'none'}`)
  }
  return { ...harness, timeline, subagent }
}

/** The events around the permission request, where the subagent's state is decided. */
function aroundRequest(timeline: string[]): string[] {
  const at = timeline.findIndex((entry) => entry.startsWith('can_use_tool'))
  return timeline.slice(at - 1, at + 3)
}

describe('a Claude subagent waiting on a permission request', () => {
  it('reads waiting from the request until it is allowed, then working', async () => {
    const { timeline } = await replay('fg-allow')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'allow -> live working',
      'session_state_changed -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it('keeps the tool it is blocked on while it waits', async () => {
    const harness = await producer()
    const events = capturedScenario('fg-allow')
    const request = events.findIndex((event) => event.frame.type === 'control_request')
    for (const { frame } of events.slice(0, request)) {
      harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    requestFromWire(harness.claude.connections[0]!, events[request]!.frame)
    expect(harness.byDescription('Touch probe file')).toMatchObject({
      state: 'waiting',
      operation: { toolName: 'Bash', input: 'touch c9-probe-fg.txt', basis: 'open' }
    })
  })

  it("feeds the parent row's fold a waiting child, under the session's own attention", async () => {
    const harness = await producer()
    const events = capturedScenario('fg-allow')
    const request = events.findIndex((event) => event.frame.type === 'control_request')
    for (const { frame } of events.slice(0, request)) {
      harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    expect(agentChildWorkLiveness(harness.records())).toBe('working')
    requestFromWire(harness.claude.connections[0]!, events[request]!.frame)
    const childWork = harness.records()
    expect(agentChildWorkLiveness(childWork)).toBe('waiting')
    // The pending request is also the session's attention, which keeps its own `blocked`.
    expect(structuredAgentSessionAgentStatus({ status: 'attention', childWork }).state).toBe(
      'blocked'
    )
    expect(structuredAgentSessionAgentStatus({ status: 'working', childWork }).state).toBe(
      'waiting'
    )
  })

  it('goes back to working when the request is denied', async () => {
    const { timeline } = await replay('fg-deny')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'deny -> live working',
      'session_state_changed -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it('stops waiting when an interrupt cancels the request, then settles cancelled', async () => {
    const { timeline, subagent } = await replay('fg-interrupt')
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'interrupt -> live waiting',
      'control_cancel_request -> live working'
    ])
    // The spawn call's error result lands first and ends nothing; the child's own `killed` status
    // is what settles it, and names how it ended.
    expect(
      timeline.slice(timeline.indexOf('control_cancel_request -> live working') + 1, -1)
    ).toEqual([
      'session_state_changed -> live working',
      'user -> live working',
      'task_updated -> settled done',
      'task_notification -> settled done',
      'user -> settled done'
    ])
    expect(subagent()).toMatchObject({ membership: 'settled', outcome: 'cancelled' })
  })

  it('settles a subagent that genuinely failed as failed', async () => {
    // Captured with the subagent on a model that does not exist: its own status arrives first.
    const { timeline, subagent } = await replay('fg-fail')
    expect(timeline.find((entry) => !entry.endsWith('none'))).toBe('task_started -> live working')
    expect(subagent()).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      lastMessage: expect.stringContaining('Agent terminated early due to an API error')
    })
  })

  it('keeps a background subagent waiting after the parent turn ends, until it is allowed', async () => {
    const { timeline } = await replay('bg-allow')
    const at = timeline.indexOf('can_use_tool -> live waiting')
    expect(at).toBeGreaterThan(-1)
    // The parent's own turn ends while the background subagent is still asking.
    expect(timeline.slice(at, at + 4)).toEqual([
      'can_use_tool -> live waiting',
      'assistant -> live waiting',
      'success -> live waiting',
      'allow -> live working'
    ])
    expect(timeline.at(-1)).toBe('success -> settled done')
  })

  it('joins through the tool call it gates when the CLI does not name the subagent', async () => {
    const { timeline } = await replay('fg-allow', { withoutAgentId: true })
    expect(aroundRequest(timeline)).toEqual([
      'session_state_changed -> live working',
      'can_use_tool -> live waiting',
      'allow -> live working',
      'session_state_changed -> live working'
    ])
  })

  it('names the subagent from the request before its tool call reaches the journal', async () => {
    // The SDK answers control requests as they arrive but hands frames over in order, so a request
    // can land before the subagent's own tool call has been read.
    const harness = await producer()
    const events = capturedScenario('fg-allow')
    const request = events.findIndex((event) => event.frame.type === 'control_request')
    const toolCall = events
      .slice(0, request)
      .map((event) => event.frame.type)
      .lastIndexOf('assistant')
    for (const { frame } of events.slice(0, toolCall)) {
      harness.send({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    requestFromWire(harness.claude.connections[0]!, events[request]!.frame)
    expect(harness.byDescription('Touch probe file')?.state).toBe('waiting')
  })

  it("leaves no child waiting when the session's own agent asks", async () => {
    const { timeline, records } = await replay('main-allow')
    expect(timeline.every((entry) => entry.endsWith('-> none'))).toBe(true)
    expect(records()).toEqual([])
  })
})
