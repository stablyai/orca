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

function harness() {
  // `options` is captured, not declared away: producer attribution rides the
  // third argument, and a harness that drops it makes every assertion about
  // attribution pass against `undefined`.
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
    // Drives the streamed coalescer by hand, so a test can place an
    // announcement precisely before or after a checkpoint lands.
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
  /** Attribution stamped on a row, found by the text it carries, so a test
   *  names the row it means instead of indexing into the append order. */
  const writesOfProse = (text: string) =>
    items.filter(
      (entry) =>
        entry.body.kind === 'message' &&
        entry.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )
  /** Attribution a row ENDS UP with. Rows are written immediately and
   *  re-attributed in place, so the newest write is the one that renders —
   *  reading the first would assert against a stamp already superseded. */
  const linkageOfProse = (text: string): StructuredAgentSessionAppendOptions | undefined =>
    writesOfProse(text).at(-1)?.options
  return {
    translator,
    items,
    groupRows,
    roster,
    rosterIn,
    rosterOf,
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

describe('claude journal translation — which agent produced a row', () => {
  /** One child assistant frame carrying prose, parented to a spawn call. */
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

  /** The parent's own `Task` call, which is what forwards the spawn id. */
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

  /** A tool call the CHILD makes. Its id exists only inside that sidechain, and
   *  is the one handle the grandchild's own frames will carry. */
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
    // A control, not a pin: the parent's rows carry no linkage before this
    // change either. It is here because "absence means root" is only sound
    // while the producer really does leave its own rows alone.
    expect(linkageOfProse('delegating')?.agentId).toBeUndefined()
  })

  it('keeps one identity across a resume that re-mints the spawn call id', () => {
    // THE case the canonical id exists for: the same child announced twice
    // under two different tool ids. Both runs' rows must name one agent.
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
    // Identity answers "which agent"; the attempt answers "which run of it".
    expect(linkageOfProse('first run')?.attempt).toBeUndefined()
    expect(linkageOfProse('second run')?.attempt).toBe(2)
  })

  it('holds a child row that arrives before its announcement, then writes it linked', () => {
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    // Another child has already proven this release announces its tasks, so a
    // spawn with no announcement yet is a window, not a release without one.
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childProse('child-1', 'toolu_1', 'arrived early'))

    // Written at once, under the only handle that exists yet — never withheld,
    // and never the parent's.
    expect(linkageOfProse('arrived early')).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    // Re-attributed in place once the announcement names it.
    expect(linkageOfProse('arrived early')).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
  })

  it('burns no revision correcting a row whose producer was never named', () => {
    // The turn ends with the identity still provisional. The row already says
    // what settle would say, so the correction must be DROPPED: a duplicate
    // rewrite would cost a revision and change nothing.
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

  it('stamps a spawn call a release never announces with the call\u2019s own id', () => {
    // Older releases name nothing they spawn. The spawn call is still in the
    // transcript, so its id is a real handle — and stamping it keeps the child's
    // prose off the parent, which reading these rows as root would not.
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'unannounced release'))

    expect(linkageOfProse('unannounced release')).toMatchObject({ agentId: 'toolu_1' })
  })

  it('never reads a row naming a parent as the session\u2019s own, whatever the release', () => {
    // The hardest case for attribution: a sidechain id no spawn call forwarded,
    // on a release that has announced nothing, so no announcement is coming and
    // no correction ever will. There is still a handle — the reference itself —
    // and the row is stamped with it. Reading it as root would assert the parent
    // wrote words a child wrote, which is the defect, not a fallback.
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(childProse('child-1', 'toolu_nested', 'no announcement coming'))

    expect(linkageOfProse('no announcement coming')).toMatchObject({
      agentId: 'toolu_nested',
      providerParentRef: 'toolu_nested'
    })
    // Positively non-root: this is what every parent-scoped reader tests.
    expect(linkageOfProse('no announcement coming')?.agentId).not.toBeUndefined()
  })

  it("attributes a tool result naming its own call to the call's own agent", () => {
    // Every top-level call is a forwarded tool id, not just a spawn. Reading the
    // parent reference literally on a result frame would park ordinary tool
    // output against a `task_started` that is never coming, leaving the tool row
    // stuck `running` for the rest of the turn.
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
    expect(row?.options).toEqual({})
  })

  /** One streamed text block, as the SDK sends it: a message start, then deltas.
   *  Streamed prose has no envelope when it is persisted, so its producer has to
   *  travel with the delta. */
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
    // The primary prose path, and the shape nothing revisits: the child streams,
    // stops, and no final envelope ever arrives — so only re-attribution can
    // move the row off the id it was written under.
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
    // Written at once, and never as the parent's.
    expect(streamed().at(-1)?.options).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(streamed().at(-1)?.options).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
    expect(streamed().at(-1)?.options?.agentId).not.toBeUndefined()
  })

  /** The result of a call a CHILD made, naming its own call as parent. */
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
    // The module's own invariant, pinned directly. A correction re-appends a
    // row to restamp it; if it carries a body older than the row's newest, it
    // silently reverts content — which is how a completed tool row went back to
    // running. Asserted across every row this session writes, not one shape.
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

    // ONLY the announcement frame, so the window holds re-attributions and not
    // a turn settling or any other legitimate body revision.
    translator.handle(announce('task-1', 'toolu_1'))

    const corrections = items.slice(writesBefore)
    // The announcement DID rewrite rows, or this proves nothing.
    expect(corrections.length).toBeGreaterThan(0)
    for (const correction of corrections) {
      const itemId = idOf(correction)
      // The roster's own group row is excluded: the announcement re-keys a
      // provisional child onto its canonical id, so that row's body is SUPPOSED
      // to change here. Every other rewrite on this frame is a re-attribution.
      if (itemId.startsWith('claude-subagents:')) {
        continue
      }
      const before = bodyBeforeAnnouncement.get(itemId)
      if (before === undefined) {
        continue
      }
      // Re-attribution only: the body a correction carries is the body the row
      // already had. Carrying an older one silently reverts content.
      expect(correction.body).toEqual(before)
    }

    const nested = items.findLast(
      (entry) => orcaClientMessageId(entry.identity) === 'claude-tool:claude-session:toolu_2'
    )
    expect(nested?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    expect(nested?.options?.agentId).toBe('task-1')
  })

  it('keeps a long pre-announcement burst on ONE id, with no row left at root', () => {
    // The burst that outruns the announcement. Every row must name the same
    // producer: a row at `{}` is the parent claiming the child's words, and a
    // burst split across two ids is one child appearing as two.
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
    // The canonical id, not merely a consistent one: 70 is inside the bound, so
    // every row is actually corrected rather than given up on.
    expect(finalAgentIds).toEqual(new Set(['task-1']))
  })

  it("corrects the session's FIRST child, whose spawn is unannounced only so far", () => {
    // The release check reads "no task announced yet", which every session looks
    // like before its first `task_started`. Without the spawn call outranking
    // it, the first child's pre-announcement rows persist as the PARENT's — the
    // whole defect, for the first child of every session.
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'first child prose'))

    // Never the parent's, not even for the window before the announcement.
    expect(linkageOfProse('first child prose')).toMatchObject({ agentId: 'toolu_1' })

    translator.handle(announce('task-1', 'toolu_1'))

    expect(linkageOfProse('first child prose')).toMatchObject({
      agentId: 'task-1',
      providerParentRef: 'toolu_1'
    })
  })

  it('stamps nested sidechain traffic this release will never announce', () => {
    // A grandchild parented to a tool id that only ever existed inside a
    // sidechain. No announcement is coming, so the raw reference is the only
    // handle — but the row is still a child's, never the parent's.
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childProse('grandchild-1', 'toolu_nested', 'deeper'))

    expect(linkageOfProse('deeper')).toMatchObject({
      agentId: 'toolu_nested',
      providerParentRef: 'toolu_nested'
    })
    // The call that opened this sidechain was never journaled, so who spawned
    // it is genuinely unknown and the row claims nothing.
    expect(linkageOfProse('deeper')?.parentAgentId).toBeUndefined()
  })

  it('names the child that spawned a grandchild rather than leaving it on the session', () => {
    // The grandchild's frames carry one handle: the nested call id. That id was
    // journaled on the CHILD's own row, which is the only place the real parent
    // is recoverable — and without it the row's absent parent would read as a
    // claim that the session's own agent spawned it.
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
    // A row names its parent as well as its producer, and the parent's identity
    // can still be provisional. It is written with whatever the parent's own
    // rows carry AT THAT MOMENT, so the two never disagree, and the
    // announcement corrects both together.
    const { translator, linkageOfProse } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    // Some other task announced, so this release has proven it declares them.
    translator.handle(announce('task-other', 'toolu_other'))
    translator.handle(childSpawnCall('child-1', 'toolu_1', 'toolu_nested'))
    translator.handle(childProse('grandchild-1', 'toolu_nested', 'held deeper'))
    // Written at once, naming the parent by the same handle the parent's own
    // rows carry right now — not left blank, which would claim the session's
    // own agent spawned it.
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
    // Teardown cannot improve the stamp and must not undo it: the row was
    // already written as this child's, and dispose leaves it that way rather
    // than re-resolving after the roster forgets what the session announced.
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

  it("leaves the spawn-group row the parent's, though a child frame triggered it", () => {
    // Hazard: the group row is written from a child's frame but describes the
    // PARENT's children. Stamping it as a child's would hide the roster from
    // the very row that owns it. Asserted on the written row, not on a field.
    const { translator, groupRows } = harness()
    translator.handle(userTurn('user-1'))
    translator.handle(spawnCall('assistant-1', 'toolu_1'))
    translator.handle(announce('task-1', 'toolu_1'))
    translator.handle(childProse('child-1', 'toolu_1', 'looking'))

    const groupRow = groupRows().at(-1)
    expect(groupRow).toBeDefined()
    expect(groupRow?.options?.agentId).toBeUndefined()
  })
})
