import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function orcaClientMessageId(identity: AgentJournalItemIdentity): string | null {
  return identity.provider === 'orca' ? identity.clientMessageId : null
}

function harness() {
  // Capture the third append argument: it carries producer attribution.
  const items: {
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: StructuredAgentSessionAppendOptions | undefined
  }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => items.push({ identity, body, options }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  let scheduled: (() => void) | null = null
  const translator = createClaudeJournalTranslator({
    sink,
    fallbackIdPrefix: 'test',
    // Control checkpoint timing relative to identity announcements.
    schedule: (run) => {
      scheduled = run
      return () => {
        scheduled = null
      }
    }
  })
  const runStreamWindow = (): void => {
    const run = scheduled as (() => void) | null
    run?.()
  }
  const fallbackRows = (): AgentJournalItemBody[] =>
    items
      .filter((item) => (orcaClientMessageId(item.identity) ?? '').startsWith('provider-frame:'))
      .map((item) => item.body)
  const writesOfProse = (text: string) =>
    items.filter(
      (entry) =>
        entry.body.kind === 'message' &&
        entry.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )
  /** Corrections replace attribution in place, so inspect the newest write. */
  const linkageOfProse = (text: string): StructuredAgentSessionAppendOptions | undefined =>
    writesOfProse(text).at(-1)?.options
  return {
    translator,
    items,
    fallbackRows,
    linkageOfProse,
    writesOfProse,
    runStreamWindow
  }
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

describe('claude journal translation — subagents', () => {
  it('writes no subagent rows of its own: the host saves each one from its records', () => {
    const { translator, items, fallbackRows } = harness()
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
    translator.handle(spawnResult('user-2', 'toolu_1'))
    translator.handle(resultFrame())
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    expect(
      items.filter(
        (item) =>
          item.body.kind === 'message' &&
          item.body.blocks.some(
            (block) => block.type === 'subagent' || block.type === 'subagent-group'
          )
      )
    ).toEqual([])
    expect(fallbackRows()).toEqual([])
  })
})

describe('claude journal translation — which agent produced a row', () => {
  function childProse(uuid: string, parentToolUseId: string, text: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: parentToolUseId,
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      }
    }
  }

  function spawnCall(uuid: string, toolUseId: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: toolUseId, name: 'Task', input: { description: 'explore' } }
          ]
        }
      }
    }
  }

  function childSpawnCall(uuid: string, parentToolUseId: string, toolUseId: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: parentToolUseId,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: toolUseId, name: 'Task', input: { description: 'deeper' } }
          ]
        }
      }
    }
  }

  function announce(taskId: string, toolUseId: string) {
    return systemFrame('task_started', {
      task_id: taskId,
      tool_use_id: toolUseId,
      task_type: 'local_agent',
      subagent_type: 'explorer',
      description: 'Map the lane'
    })
  }

  it("stamps the child's canonical task id, not the spawn call's rotating id", () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'looking'))

    expect(linkageOfProse('looking')).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1',
      producerKind: 'agent'
    })
  })

  it("leaves the parent's own rows unstamped, which is what makes absence mean root", () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'delegating' }] }
      }
    })
    expect(linkageOfProse('delegating')?.agentId).toBeUndefined()
  })

  it('keeps one identity across a resume that re-mints the spawn call id', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'first run'))

    translator.handle(spawnCall('assistant-2', 'toolu_2'))
    translator.handle(announce('task-1', 'toolu_2'))
    translator.handle(childProse('child-2', 'toolu_2', 'second run'))

    expect(linkageOfProse('first run')?.agentId).toBe('task-1')
    expect(linkageOfProse('second run')?.agentId).toBe('task-1')
    expect(linkageOfProse('first run')?.attempt).toBeUndefined()
    expect(linkageOfProse('second run')?.attempt).toBe(2)
  })

  it('holds a child row that arrives before its announcement, then writes it linked', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    // Establish announcement support before testing a delayed announcement.
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childProse('child-1', 'toolu_1', 'arrived early'))

    expect(linkageOfProse('arrived early')).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(linkageOfProse('arrived early')).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
  })

  it('burns no revision correcting a row whose producer was never named', () => {
    const { translator, linkageOfProse, writesOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childProse('child-1', 'toolu_1', 'never announced'))
    expect(writesOfProse('never announced')).toHaveLength(1)

    translator.handle(resultFrame())

    expect(writesOfProse('never announced')).toHaveLength(1)
    expect(linkageOfProse('never announced')).toMatchObject({
      agentId: 'toolu_1',
      providerParentRef: 'toolu_1'
    })
  })

  it('never reads a row naming a parent as the session\u2019s own, whatever the release', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(childProse('child-1', 'toolu_nested', 'no announcement coming'))

    expect(linkageOfProse('no announcement coming')).toMatchObject({
      agentId: 'toolu_nested',
      providerParentRef: 'toolu_nested'
    })
    expect(linkageOfProse('no announcement coming')?.agentId).not.toBeUndefined()
  })

  it("attributes a tool result naming its own call to the call's own agent", () => {
    // A result names its own tool call as parent, not an unannounced child.
    const { translator, items } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'user',
        uuid: 'bash-result',
        session_id: 'claude-session',
        parent_tool_use_id: 'toolu_bash',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'a.ts' }]
        }
      }
    })

    const row = items.find(
      (entry) => orcaClientMessageId(entry.identity) === 'claude-tool:claude-session:toolu_bash'
    )
    expect(row?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    expect(row?.options).toEqual({
      turnScope: { kind: 'turn', turnItemId: expect.any(String) }
    })
  })

  /** Attribute streamed prose from deltas before a final envelope exists. */
  function streamStart(uuid: string, parentToolUseId: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: parentToolUseId,
        event: { type: 'message_start', message: { id: 'msg-1' } }
      }
    }
  }

  function streamDelta(uuid: string, parentToolUseId: string, text: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: parentToolUseId,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      }
    }
  }

  it('re-attributes streamed prose that stopped before its announcement', () => {
    const { translator, items, runStreamWindow } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(streamStart('stream-1', 'toolu_1'))
    translator.handle(streamDelta('stream-1', 'toolu_1', 'thinking out loud'))
    runStreamWindow()

    const streamed = () =>
      items.filter(
        (entry) =>
          entry.body.kind === 'message' &&
          entry.body.blocks.some(
            (block) => block.type === 'text' && block.text === 'thinking out loud'
          )
      )
    expect(streamed().at(-1)?.options).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(streamed().at(-1)?.options).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
    expect(streamed().at(-1)?.options?.agentId).not.toBeUndefined()
  })

  function childToolResult(uuid: string, toolUseId: string) {
    return {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'user',
        uuid,
        session_id: 'claude-session',
        parent_tool_use_id: toolUseId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'deeper done' }]
        }
      }
    }
  }

  const toolRowWrites = (
    items: readonly {
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      options: StructuredAgentSessionAppendOptions | undefined
    }[],
    toolUseId: string
  ) =>
    items.filter(
      (entry) => orcaClientMessageId(entry.identity) === `claude-tool:claude-session:${toolUseId}`
    )

  it('does not revert a completed nested tool row when its attribution is corrected', () => {
    const { translator, items } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(childSpawnCall('child-1', 'toolu_1', 'toolu_2'))
    translator.handle(childToolResult('child-result', 'toolu_2'))
    translator.handle(announce('task-1', 'toolu_1'))

    const last = toolRowWrites(items, 'toolu_2').at(-1)
    expect(last?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    expect(last?.options?.agentId).toBe('task-1')
  })

  it('never lets a correction change a row\u2019s content, only its attribution', () => {
    const { translator, items } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'talking'))
    translator.handle(childSpawnCall('child-2', 'toolu_1', 'toolu_2'))
    translator.handle(childToolResult('child-result', 'toolu_2'))

    const idOf = (entry: { identity: AgentJournalItemIdentity }): string =>
      orcaClientMessageId(entry.identity) ?? JSON.stringify(entry.identity)
    const bodyBeforeAnnouncement = new Map<string, AgentJournalItemBody>()
    for (const entry of items) {
      bodyBeforeAnnouncement.set(idOf(entry), entry.body)
    }
    const writesBefore = items.length

    // Isolate attribution corrections from lifecycle or content changes.
    translator.handle(announce('task-1', 'toolu_1'))

    const corrections = items.slice(writesBefore)
    expect(corrections.length).toBeGreaterThan(0)
    for (const correction of corrections) {
      const itemId = idOf(correction)
      // Roster rows legitimately change their body when a provisional identity becomes canonical.
      if (itemId.startsWith('claude-subagents:')) {
        continue
      }
      const before = bodyBeforeAnnouncement.get(itemId)
      if (before === undefined) {
        continue
      }
      expect(correction.body).toEqual(before)
    }

    const nested = items.findLast(
      (entry) => orcaClientMessageId(entry.identity) === 'claude-tool:claude-session:toolu_2'
    )
    expect(nested?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    expect(nested?.options?.agentId).toBe('task-1')
  })

  it('keeps a long pre-announcement burst on ONE id, with no row left at root', () => {
    const { translator, items } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    for (let index = 0; index < 70; index += 1) {
      translator.handle(childProse(`child-${index}`, 'toolu_1', `line ${index}`))
    }
    translator.handle(announce('task-1', 'toolu_1'))

    const finalAgentIds = new Set<string | undefined>()
    for (let index = 0; index < 70; index += 1) {
      const writes = items.filter(
        (entry) =>
          entry.body.kind === 'message' &&
          entry.body.blocks.some((block) => block.type === 'text' && block.text === `line ${index}`)
      )
      expect(writes.length).toBeGreaterThan(0)
      finalAgentIds.add(writes.at(-1)?.options?.agentId)
    }
    // Seventy rows fit within the correction bound, so every row should become canonical.
    expect(finalAgentIds).toEqual(new Set(['task-1']))
  })

  it("corrects the session's FIRST child, whose spawn is unannounced only so far", () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'first child prose'))

    expect(linkageOfProse('first child prose')).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(linkageOfProse('first child prose')).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
  })

  it('stamps nested sidechain traffic this release will never announce', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childProse('grandchild-1', 'toolu_nested', 'deeper'))

    expect(linkageOfProse('deeper')).toMatchObject({
      agentId: 'toolu_nested',
      providerParentRef: 'toolu_nested'
    })
    expect(linkageOfProse('deeper')?.parentAgentId).toBeUndefined()
  })

  it('names the child that spawned a grandchild rather than leaving it on the session', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childSpawnCall('child-1', 'toolu_1', 'toolu_nested'))
    translator.handle(childProse('grandchild-1', 'toolu_nested', 'deeper'))

    expect(linkageOfProse('deeper')).toMatchObject({
      agentId: 'toolu_nested',
      parentAgentId: 'task-1',
      providerParentRef: 'toolu_nested'
    })
  })

  it('keeps a grandchild and its parent on the same id, before and after', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childSpawnCall('child-1', 'toolu_1', 'toolu_nested'))
    translator.handle(childProse('grandchild-1', 'toolu_nested', 'held deeper'))
    expect(linkageOfProse('held deeper')).toMatchObject({
      agentId: 'toolu_nested',
      parentAgentId: 'toolu_1'
    })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(linkageOfProse('held deeper')).toMatchObject({
      agentId: 'toolu_nested',
      parentAgentId: 'task-1'
    })
  })

  it('leaves a row a child’s when the session is torn down mid-flight', () => {
    const { translator, linkageOfProse, writesOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childProse('child-1', 'toolu_1', 'still open at teardown'))
    expect(writesOfProse('still open at teardown')).toHaveLength(1)

    translator.dispose()

    expect(writesOfProse('still open at teardown')).toHaveLength(1)
    expect(linkageOfProse('still open at teardown')).toMatchObject({
      agentId: 'toolu_1',
      providerParentRef: 'toolu_1'
    })
  })

  it('classifies a backgrounded shell task as background work, not as an agent', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_bash'))
    translator.handle(
      systemFrame('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash',
        description: 'sleep 20',
        is_backgrounded: true
      })
    )
    translator.handle(childProse('bash-1', 'toolu_bash', 'shell output'))

    expect(linkageOfProse('shell output')).toMatchObject({ producerKind: 'background' })
  })
})
