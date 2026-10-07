import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../shared/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexThreadItem } from './codex-thread-item-identity'
import { CODEX_COMMAND_APPROVAL_METHOD } from './codex-structured-prompt-replies'

const SESSION = 'session-1'
const PARENT = 'thread-parent'
const CHILD = 'thread-child'
const GRANDCHILD = 'thread-grandchild'
const CHILD_LINKAGE = { agentId: CHILD, producerKind: 'agent' }

type Written = { key: string; body: AgentJournalItemBody; linkage: AgentJournalProducerLinkage }

/** Records the linkage every write carries — plain appends, batch mutations and
 *  lifecycle transitions alike — so an assertion about attribution can never
 *  pass against a harness that dropped it. */
function harness(primaryThreadId: string | null = PARENT) {
  const writes: Written[] = []
  const record = (
    identity: Parameters<typeof agentJournalItemKey>[0],
    body: AgentJournalItemBody,
    options: AgentJournalProducerLinkage | undefined
  ) =>
    writes.push({
      key: agentJournalItemKey(identity),
      body,
      linkage: agentJournalLinkageFields(options)
    })
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => record(identity, body, options),
    tryAppendItem: (identity, body, options) => {
      record(identity, body, options)
      return { accepted: true }
    },
    tryAppendLifecycleBatch: (_settlementId, mutations) => {
      for (const mutation of mutations) {
        if (mutation.kind === 'item') {
          record(mutation.identity, mutation.body, mutation.linkage)
        }
      }
      return { accepted: true }
    },
    tryAppendLifecycleTransition: (identity, body, _resolve, options) => {
      record(identity, body, options)
      return { accepted: true }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: SESSION,
    primaryThreadId: () => primaryThreadId,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const on = (threadId: string, method: string, params: Record<string, unknown> = {}) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId,
      method,
      params: { threadId, ...params }
    })
  const item = (threadId: string, method: string, turnId: string, body: CodexThreadItem) =>
    on(threadId, method, { turnId, item: body })
  const spawn = (spawner: string, turnId: string, child: string, path: string) => {
    const body = {
      type: 'subAgentActivity',
      id: `spawn-${child}`,
      kind: 'started',
      agentThreadId: child,
      agentPath: path
    }
    item(spawner, 'item/started', turnId, body)
    item(spawner, 'item/completed', turnId, body)
  }
  /** The linkage on the newest write whose serialized body mentions `text`. */
  const linkageOf = (text: string): AgentJournalProducerLinkage | undefined =>
    writes.findLast((write) => JSON.stringify(write.body).includes(text))?.linkage
  return { translator, writes, on, item, spawn, linkageOf }
}

describe('codex journal translation — subagent producer linkage', () => {
  it("stamps every row a child thread produces, and nothing on the session's own", () => {
    const { on, item, spawn, linkageOf, writes } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    spawn(PARENT, 'pt', CHILD, '/root/review')
    on(CHILD, 'turn/started', { turn: { id: 'ct' } })
    const command = { type: 'commandExecution', id: 'cmd-1', command: 'pnpm test' }
    item(CHILD, 'item/started', 'ct', { ...command, status: 'inProgress' })
    on(CHILD, 'item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'streamed out' })
    item(CHILD, 'item/completed', 'ct', { ...command, status: 'completed', exitCode: 0 })
    item(CHILD, 'item/completed', 'ct', { type: 'agentMessage', id: 'm-1', text: 'child prose' })
    item(PARENT, 'item/completed', 'pt', { type: 'agentMessage', id: 'm-2', text: 'own prose' })

    const commandRows = writes.filter((write) => write.key.includes('cmd-1'))
    // Start, streamed checkpoint and completion: every revision restates it.
    expect(commandRows.length).toBeGreaterThanOrEqual(3)
    expect(commandRows.map((write) => write.linkage)).toEqual(commandRows.map(() => CHILD_LINKAGE))
    expect(linkageOf('child prose')).toEqual(CHILD_LINKAGE)
    expect(linkageOf('own prose')).toEqual({})
    // The spawn-group row is the parent's list of its children, though a child's
    // frames also write it.
    expect(
      writes.filter((write) => write.key.includes('codex-subagents')).map((w) => w.linkage)
    ).toEqual(expect.arrayContaining([{}]))
    expect(
      writes.filter((write) => write.key.includes('codex-subagents') && write.linkage.agentId)
    ).toEqual([])
  })

  it('stamps a child row that arrives before the spawn announcement names it', () => {
    // The thread already proves it is not the session's own; only the parent
    // and run are learned from the announcement.
    const { on, item, linkageOf } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    item(CHILD, 'item/completed', 'ct', { type: 'agentMessage', id: 'm-1', text: 'early words' })

    expect(linkageOf('early words')).toEqual(CHILD_LINKAGE)
  })

  it('names the child that spawned a grandchild, from the thread that announced it', () => {
    const { on, item, spawn, linkageOf } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    spawn(PARENT, 'pt', CHILD, '/root/lead')
    on(CHILD, 'turn/started', { turn: { id: 'ct' } })
    spawn(CHILD, 'ct', GRANDCHILD, '/root/lead/worker')
    // An `interacted` activity rides whichever agent acted, so it names no parent.
    item(CHILD, 'item/completed', 'ct', {
      type: 'subAgentActivity',
      id: 'poke-parent',
      kind: 'interacted',
      agentThreadId: 'thread-sibling',
      agentPath: '/root/sibling'
    })
    on(GRANDCHILD, 'turn/started', { turn: { id: 'gt' } })
    item(GRANDCHILD, 'item/completed', 'gt', { type: 'agentMessage', id: 'g', text: 'grand words' })
    item(CHILD, 'item/completed', 'ct', { type: 'agentMessage', id: 'c', text: 'child words' })
    item('thread-sibling', 'item/completed', 'st', { type: 'agentMessage', id: 's', text: 'sib' })

    expect(linkageOf('grand words')).toEqual({
      ...CHILD_LINKAGE,
      agentId: GRANDCHILD,
      parentAgentId: CHILD
    })
    expect(linkageOf('child words')).toEqual(CHILD_LINKAGE)
    expect(linkageOf('sib')).toEqual({ agentId: 'thread-sibling', producerKind: 'agent' })
  })

  it("names the child's run by the row's own turn, so a shell outliving its turn keeps it", () => {
    const { on, item, spawn, linkageOf } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    spawn(PARENT, 'pt', CHILD, '/root/review')
    on(CHILD, 'turn/started', { turn: { id: 'ct-1' } })
    const shell = {
      type: 'commandExecution',
      id: 'dev-server',
      command: 'pnpm dev',
      source: 'unifiedExecStartup'
    }
    item(CHILD, 'item/started', 'ct-1', { ...shell, status: 'inProgress' })
    on(CHILD, 'turn/completed', { turn: { id: 'ct-1', status: 'completed' } })
    // A follow-up from the parent is the child's second run.
    on(CHILD, 'turn/started', { turn: { id: 'ct-2' } })
    item(CHILD, 'item/completed', 'ct-2', { type: 'agentMessage', id: 'r2', text: 'second run' })
    item(CHILD, 'item/completed', 'ct-1', { ...shell, status: 'completed', exitCode: 0 })

    expect(linkageOf('second run')).toEqual({ ...CHILD_LINKAGE, attempt: 2 })
    expect(linkageOf('pnpm dev')).toEqual(CHILD_LINKAGE)
  })

  it("settles every thread's rows in one exit batch, each under its own producer", () => {
    const { translator, on, item, spawn, writes } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    spawn(PARENT, 'pt', CHILD, '/root/review')
    on(CHILD, 'turn/started', { turn: { id: 'ct' } })
    item(PARENT, 'item/started', 'pt', {
      type: 'commandExecution',
      id: 'own',
      command: 'ls',
      status: 'inProgress'
    })
    item(CHILD, 'item/started', 'ct', {
      type: 'commandExecution',
      id: 'kid',
      command: 'rg x',
      status: 'inProgress'
    })
    translator.handle({
      type: 'prompt',
      sessionId: SESSION,
      threadId: CHILD,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { turnId: 'ct' },
      codexItemId: 'kid',
      promptKey: 'child-approval'
    })
    const beforeExit = writes.length
    translator.handle({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'generation-1'
    })

    const settled = writes.slice(beforeExit)
    const producerOf = (fragment: string) =>
      settled.find((write) => write.key.includes(fragment))?.linkage
    expect(producerOf('kid')).toEqual(CHILD_LINKAGE)
    expect(producerOf('child-approval')).toEqual(CHILD_LINKAGE)
    expect(producerOf('own')).toEqual({})
    // A turn is the session's unit of work and never carries a producer.
    const turnRows = settled.filter((write) => write.body.kind === 'turn')
    expect(turnRows.length).toBe(1)
    expect(turnRows[0]?.linkage).toEqual({})
    // The child's approval was admitted under the child, too.
    expect(writes[writes.findIndex((w) => w.key.includes('child-approval'))]?.linkage).toEqual(
      CHILD_LINKAGE
    )
  })

  it("stamps a child's provider frames and goal rows, which are journaled per thread", () => {
    const { on, spawn, writes } = harness()
    on(PARENT, 'turn/started', { turn: { id: 'pt' } })
    spawn(PARENT, 'pt', CHILD, '/root/review')
    on(CHILD, 'turn/started', { turn: { id: 'ct' } })
    on(CHILD, 'error', {
      turnId: 'ct',
      error: { message: 'child hit a rate limit' },
      willRetry: true
    })
    on(CHILD, 'thread/goal/updated', {
      turnId: 'ct',
      goal: {
        threadId: CHILD,
        objective: 'Review the diff',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      }
    })

    const frame = writes.find((write) => JSON.stringify(write.body).includes('rate limit'))
    const goal = writes.find((write) => JSON.stringify(write.body).includes('Review the diff'))
    expect(frame?.linkage).toEqual(CHILD_LINKAGE)
    // A goal belongs to the thread, not one run of it: no attempt, ever.
    expect(goal?.linkage).toEqual(CHILD_LINKAGE)
  })

  it('stamps nothing while the session thread is still opening', () => {
    const { item, linkageOf } = harness(null)
    item('thread-x', 'item/completed', 't', { type: 'agentMessage', id: 'm', text: 'too early' })

    expect(linkageOf('too early')).toEqual({})
  })
})
