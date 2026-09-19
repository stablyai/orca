import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const GROUP_ITEM_ID = 'claude-subagents:claude-session:user-1'

/** The union's other arms carry no client message id, so reading one narrows. */
function orcaClientMessageId(identity: AgentJournalItemIdentity): string | null {
  return identity.provider === 'orca' ? identity.clientMessageId : null
}

type AppendedItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: StructuredAgentSessionAppendOptions | undefined
}

function harness() {
  const items: AppendedItem[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => items.push({ identity, body, options }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  const groupRows = () =>
    items.filter((item) => orcaClientMessageId(item.identity) === GROUP_ITEM_ID)
  const agentsOf = (body: AgentJournalItemBody | undefined): NativeChatSubagentEntry[] => {
    if (!body || body.kind !== 'message') {
      return []
    }
    const block = body.blocks.find(
      (candidate): candidate is NativeChatSubagentGroupBlock => candidate.type === 'subagent-group'
    )
    return block ? block.agents : []
  }
  /** The last roster row written for one group, so a test can read a group that
   *  is no longer the live one. */
  const rosterIn = (groupId: string): NativeChatSubagentEntry[] =>
    agentsOf(
      items.findLast((item) => orcaClientMessageId(item.identity) === `claude-subagents:${groupId}`)
        ?.body
    )
  const rosterOf = (turnUuid: string): NativeChatSubagentEntry[] =>
    rosterIn(`claude-session:${turnUuid}`)
  const roster = (): NativeChatSubagentEntry[] => agentsOf(groupRows().at(-1)?.body)
  const fallbackRows = (): AgentJournalItemBody[] =>
    items
      .filter((item) => (orcaClientMessageId(item.identity) ?? '').startsWith('provider-frame:'))
      .map((item) => item.body)
  /** Every append the translator made, with the options it passed — the third argument
   *  this harness used to discard, which is where producer attribution rides. */
  const appended = (): AppendedItem[] => items
  return { translator, groupRows, roster, rosterIn, rosterOf, fallbackRows, appended }
}

function userTurn(uuid: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    startsTurn: true as const,
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
    }
  }
}

function systemFrame(subtype: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: { type: 'system', subtype, session_id: 'claude-session', ...fields }
  }
}

function spawnResult(uuid: string, toolUseId: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }]
      }
    }
  }
}

function resultFrame() {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session',
      uuid: 'result-1',
      result: 'ok'
    }
  }
}

/** An assistant frame; a string `parentToolUseId` makes it a subagent's. */
function assistantFrame(
  uuid: string,
  parentToolUseId: string | null,
  content: readonly Record<string, unknown>[]
) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: { role: 'assistant', content }
    }
  }
}

/** A tool_result frame; a string `parentToolUseId` makes it a subagent's inner result. */
function toolResultFrame(uuid: string, parentToolUseId: string | null, toolUseId: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'found it' }]
      }
    }
  }
}

// Partial-message cadence: every stream_event carries its own uuid, and the block's
// scope is (session_id, parent_tool_use_id) — the only place a streamed delta says
// who produced it, because the persist callback sees no message envelope.
function streamEvent(uuid: string, parentToolUseId: string | null, event: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      event
    }
  }
}

function textDeltaEvent(index: number, text: string) {
  return { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
}

describe('claude journal translation — subagents', () => {
  it('rosters a spawned subagent and settles it on the spawn call result', () => {
    const { translator, roster, fallbackRows } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        task_type: 'local_agent',
        subagent_type: 'explorer',
        description: 'Map the lane'
      })
    )
    expect(roster()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Map the lane', state: 'working' })
    ])
    // The task frames stay status-chrome, so none of them prints an opcode row.
    expect(fallbackRows()).toEqual([])
    translator.handle(spawnResult('user-2', 'toolu_1'))
    expect(roster()).toEqual([expect.objectContaining({ state: 'completed' })])
  })

  it('marks a child still working at turn end unverifiable', () => {
    const { translator, roster } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-1',
        task_type: 'local_agent',
        description: 'Map the lane'
      })
    )
    translator.handle(resultFrame())
    expect(roster()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })

  it('leaves a backgrounded child running past the end of its turn', () => {
    const { translator, roster } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        task_type: 'local_agent',
        description: 'Watch the build',
        is_backgrounded: true
      })
    )
    // A backgrounded spawn returns its tool result immediately; the child runs on.
    translator.handle(spawnResult('user-2', 'toolu_1'))
    translator.handle(resultFrame())
    expect(roster()).toEqual([expect.objectContaining({ state: 'working' })])
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    expect(roster()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })

  it('keeps a backgrounded shell task out of the roster entirely', () => {
    const { translator, groupRows } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash',
        description: 'sleep 20',
        is_backgrounded: true
      })
    )
    translator.handle(resultFrame())
    expect(groupRows()).toEqual([])
  })

  it('shows a subagent whose release announces no task frames, from its child traffic', () => {
    const { translator, roster } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: 'child-1',
        session_id: 'claude-session',
        parent_tool_use_id: 'toolu_1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }] }
      }
    })
    expect(roster()).toEqual([
      expect.objectContaining({ id: 'toolu_1', label: 'subagent', state: 'working' })
    ])
  })

  it('settles the turn a new turn superseded, and leaves the new one running', () => {
    const { translator, rosterOf } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-1',
        task_type: 'local_agent',
        description: 'First turn'
      })
    )
    // A second turn starts with no result frame for the first: the first turn
    // ends here, and nothing else will ever name its group again.
    translator.handle(userTurn('user-2'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-2',
        task_type: 'local_agent',
        description: 'Second turn'
      })
    )
    expect(rosterOf('user-1')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    expect(rosterOf('user-2')).toEqual([expect.objectContaining({ state: 'working' })])
  })

  it('does not let an unrelated turn end settle a child announced outside a turn', () => {
    const { translator, rosterIn } = harness()
    // No turn is live yet, so this child has no turn key to belong to.
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-early',
        task_type: 'local_agent',
        description: 'Before the turn'
      })
    )
    translator.handle(userTurn('user-1'))
    translator.handle(resultFrame())
    expect(rosterIn('outside-turn')).toEqual([expect.objectContaining({ state: 'working' })])
    // The outcome still lands, which a latched `unverifiable` would have lost.
    translator.handle(
      systemFrame('task_updated', { task_id: 'task-early', patch: { status: 'completed' } })
    )
    expect(rosterIn('outside-turn')).toEqual([expect.objectContaining({ state: 'completed' })])
  })

  it('settles a child left outside every turn when the session ends', () => {
    const { translator, rosterIn } = harness()
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-early',
        task_type: 'local_agent',
        description: 'Before the turn'
      })
    )
    translator.handle(userTurn('user-1'))
    translator.handle(resultFrame())
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    expect(rosterIn('outside-turn')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })
})

describe('producer attribution', () => {
  it("stamps a subagent frame's message, tool call and tool result, and leaves the roster row alone", () => {
    const { translator, appended } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(assistantFrame('root-1', null, [{ type: 'text', text: 'delegating' }]))
    translator.handle(
      assistantFrame('child-1', 'toolu_1', [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'toolu_child', name: 'Grep', input: { pattern: 'x' } }
      ])
    )
    translator.handle(toolResultFrame('child-2', 'toolu_1', 'toolu_child'))

    const stamped = appended()
      .filter((item) => item.options?.producedBySubagent === true)
      .map((item) => item.body.kind)
    expect(stamped).toEqual(['message', 'tool-call', 'tool-call'])

    // The parent's own prose is NOT stamped, or the row would go blank instead of
    // showing what the session's own agent said.
    const rootProse = appended().find(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )
    expect(rootProse?.options?.producedBySubagent).toBeUndefined()

    // The roster group row is the PARENT's own display of its children, so it must
    // stay root — stamping it would hide the subagent list from the parent.
    const rosterRow = appended().findLast(
      (item) => orcaClientMessageId(item.identity) === GROUP_ITEM_ID
    )
    expect(rosterRow).toBeDefined()
    expect(rosterRow?.options?.producedBySubagent).toBeUndefined()
  })

  it("stamps a subagent's STREAMED prose, which carries no message envelope when it persists", () => {
    const { translator, appended } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(streamEvent('root-s1', null, textDeltaEvent(0, 'thinking it over')))
    translator.handle(streamEvent('child-s1', 'toolu_1', textDeltaEvent(0, 'searching the tree')))
    translator.flush()

    const streamed = appended().filter(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )
    expect(streamed.map((item) => item.options?.producedBySubagent)).toEqual([undefined, true])
  })

  it('leaves every row of a root-only turn unstamped', () => {
    const { translator, appended } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(
      assistantFrame('root-1', null, [
        { type: 'text', text: 'on it' },
        { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'explore' } }
      ])
    )
    translator.handle(streamEvent('root-s1', null, textDeltaEvent(0, 'more prose')))
    translator.flush()
    translator.handle(resultFrame())

    expect(appended().every((item) => item.options?.producedBySubagent === undefined)).toBe(true)
    // Positive control: the instrument can see a stamp when there is one.
    expect(appended().length).toBeGreaterThan(0)
  })

  it('leaves the turn record unstamped — a turn is only ever opened by a root frame', () => {
    const { translator, appended } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(assistantFrame('child-1', 'toolu_1', [{ type: 'text', text: 'looking' }]))
    translator.handle(resultFrame())

    const turnRows = appended().filter((item) => item.body.kind === 'turn')
    expect(turnRows.length).toBeGreaterThan(0)
    expect(turnRows.every((item) => item.options?.producedBySubagent === undefined)).toBe(true)
  })
})
