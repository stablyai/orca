// Codex's default multi-agent mode announces a helper only by the `collabAgentToolCall` that
// spawned it. These frames, through the real adapter, must register that helper the same way a
// `subAgentActivity` does: one child in the strip, the host's records and the roster row.

import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { fakeCodex, identityFor, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

// The spawn and wait items below are verbatim from a live default-mode session (codex-cli
// 0.155.0-alpha.9.2, `multi_agent` on, `multi_agent_v2` off); only the sender is the fixture's
// thread. That session sent no `subAgentActivity` at all.
const HELPER = '01a0d114-2b8e-73e2-a69b-8e86df067ae9'
const PARENT_TURN = '01a0d112-6f86-7092-8c87-b8618f259efa'
const HELPER_TURN = 'helper-turn-1'
const PROMPT =
  'Run the shell command exactly: `sleep 45; echo CHILD_DONE`. After it completes, reply with the single word `CHILD_REPLY` and nothing else.'
/** The prompt's head, as the helper's row names it. */
const LABEL = 'Run the shell command exactly: `sleep 45; echo CHILD_DONE`. After it completes,…'
const COMMAND = "/bin/zsh -lc 'sleep 45; echo CHILD_DONE'"

type Frame = { method: string; params: Record<string, unknown> }

const turn = (
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  id: string,
  status = 'completed'
): Frame => ({ method, params: { threadId, turn: { id, status } } })
const item = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  fields: Record<string, unknown>
): Frame => ({ method, params: { threadId, turnId, item: fields } })
const collab = (
  method: 'item/started' | 'item/completed',
  fields: Record<string, unknown>
): Frame =>
  item(method, THREAD_ID, PARENT_TURN, {
    type: 'collabAgentToolCall',
    senderThreadId: THREAD_ID,
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...fields
  })

const spawnStarted = collab('item/started', {
  id: 'call_dxoSnQY1cHVswlN8MGFJBxHt',
  tool: 'spawnAgent',
  status: 'inProgress',
  receiverThreadIds: [],
  prompt: PROMPT,
  model: '',
  reasoningEffort: 'medium'
})
const spawnCompleted = collab('item/completed', {
  id: 'call_dxoSnQY1cHVswlN8MGFJBxHt',
  tool: 'spawnAgent',
  status: 'completed',
  receiverThreadIds: [HELPER],
  prompt: PROMPT,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  agentsStates: { [HELPER]: { status: 'pendingInit', message: null } }
})
const waitStarted = collab('item/started', {
  id: 'call_rMn9MIAPavyhOD6ifjH38A8E',
  tool: 'wait',
  status: 'inProgress',
  receiverThreadIds: [HELPER]
})
const waitCompleted = collab('item/completed', {
  id: 'call_rMn9MIAPavyhOD6ifjH38A8E',
  tool: 'wait',
  status: 'completed',
  receiverThreadIds: [HELPER],
  agentsStates: { [HELPER]: { status: 'completed', message: 'CHILD_REPLY' } }
})
const closeCompleted = collab('item/completed', {
  id: 'call-close',
  tool: 'closeAgent',
  status: 'completed',
  receiverThreadIds: [HELPER],
  agentsStates: { [HELPER]: { status: 'shutdown', message: null } }
})
const helperShell = (method: 'item/started' | 'item/completed'): Frame =>
  item(method, HELPER, HELPER_TURN, {
    type: 'commandExecution',
    id: 'call_3iUPkSEtwkUYstngZm5CNJ52',
    command: COMMAND,
    cwd: '/work/repo',
    // Persistent exec: the only command source the strip lists.
    source: 'unifiedExecStartup',
    status: method === 'item/started' ? 'inProgress' : 'completed',
    ...(method === 'item/completed' ? { exitCode: 0, aggregatedOutput: 'CHILD_DONE\n' } : {})
  })
const helperReply = item('item/completed', HELPER, HELPER_TURN, {
  type: 'agentMessage',
  id: 'msg-child',
  text: 'CHILD_REPLY'
})
const activityStarted: Frame = item('item/started', THREAD_ID, PARENT_TURN, {
  type: 'subAgentActivity',
  id: 'activity-helper',
  kind: 'started',
  agentThreadId: HELPER,
  agentPath: '/root/sleeper'
})

async function session() {
  const codex = fakeCodex()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    onChildWorkEvidence: (_sessionId, evidence) =>
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'codex', evidence })
  })
  // The latest revision of each journal row, in first-written order.
  const rows = new Map<string, AgentJournalItemBody>()
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => rows.set(JSON.stringify(identity), body),
    appendTombstone: () => {},
    publish: () => {}
  }
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (...frames: Frame[]): void => {
    for (const frame of frames) {
      codex.connections[0]!.handlers.onNotification?.(frame.method, frame.params)
    }
  }
  const agents = (): AgentChildWorkRecord[] =>
    store.getChildren(parent).filter((record) => record.kind === 'agent')
  const commands = (): AgentChildWorkRecord[] =>
    store.getChildren(parent).filter((record) => record.kind === 'command')
  const strip = () => adapter.backgroundTaskState('session-1')?.tasks ?? []
  const toolRow = (name: string) =>
    [...rows.values()].find((body) => body.kind === 'tool-call' && body.name === name)
  const rosterRows = () =>
    [...rows.values()].flatMap((body) =>
      body.kind === 'message'
        ? body.blocks.flatMap((block) => (block.type === 'subagent-group' ? [block] : []))
        : []
    )
  const rawCollabRows = () =>
    [...rows.values()].filter(
      (body) => body.kind === 'status' && body.providerFrame?.kind === 'item:collabAgentToolCall'
    )
  return { send, agents, commands, strip, toolRow, rosterRows, rawCollabRows }
}

describe('Codex default-mode helpers', () => {
  it('registers a helper announced only by its spawn call, in the strip, the records and the roster row', async () => {
    const run = await session()
    run.send(turn('turn/started', THREAD_ID, PARENT_TURN), spawnStarted)
    // The call has not said which thread the helper is yet.
    expect(run.agents()).toEqual([])
    expect(run.strip()).toEqual([])

    run.send(spawnCompleted, turn('turn/started', HELPER, HELPER_TURN), waitStarted)
    expect(run.agents()).toEqual([
      expect.objectContaining({
        membership: 'live',
        state: 'working',
        description: LABEL,
        invocation: { invocationId: HELPER_TURN, generation: 1 }
      })
    ])
    expect(run.strip()).toEqual([
      { id: `codex-agent:${HELPER}`, kind: 'agent', description: LABEL }
    ])
    expect(run.rosterRows()).toEqual([
      expect.objectContaining({
        agents: [expect.objectContaining({ id: HELPER, label: LABEL, state: 'working' })]
      })
    ])

    // While the helper runs, its command is the helper's work, not the session's own.
    run.send(helperShell('item/started'))
    expect(run.strip()).toEqual([
      { id: `codex-agent:${HELPER}`, kind: 'agent', description: LABEL }
    ])
    expect(run.commands()).toEqual([
      expect.objectContaining({
        description: COMMAND,
        parentChildWorkId: run.agents()[0]?.childWorkId
      })
    ])

    run.send(
      helperShell('item/completed'),
      helperReply,
      turn('turn/completed', HELPER, HELPER_TURN)
    )
    expect(run.agents()).toEqual([
      expect.objectContaining({
        membership: 'settled',
        outcome: 'succeeded',
        lastMessage: 'CHILD_REPLY'
      })
    ])
    expect(run.strip()).toEqual([])
    expect(run.rosterRows().at(-1)?.agents).toEqual([
      expect.objectContaining({ id: HELPER, state: 'completed' })
    ])
  })

  it('labels a command the helper leaves running with the helper, once its turn is over', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      helperShell('item/started'),
      turn('turn/completed', HELPER, HELPER_TURN)
    )
    expect(run.strip()).toEqual([
      expect.objectContaining({ kind: 'command', description: `${LABEL} — ${COMMAND}` })
    ])
  })

  it('renders each collab call as a tool row naming its helper, never as a raw provider row', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawnStarted,
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      waitStarted
    )
    expect(run.toolRow('wait_agent')).toMatchObject({
      state: 'running',
      input: { description: LABEL, agents: [HELPER] }
    })
    run.send(turn('turn/completed', HELPER, HELPER_TURN), waitCompleted)
    expect(run.toolRow('spawn_agent')).toMatchObject({
      state: 'completed',
      input: { description: LABEL, prompt: PROMPT, model: 'gpt-5.5', agents: [HELPER] }
    })
    expect(run.toolRow('wait_agent')).toMatchObject({
      state: 'completed',
      input: { description: LABEL },
      output: expect.objectContaining({ head: 'CHILD_REPLY' })
    })
    expect(run.rawCollabRows()).toEqual([])
  })

  it('keeps naming the helper when the turn ends with its wait still open', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      waitStarted,
      turn('turn/completed', THREAD_ID, PARENT_TURN, 'interrupted')
    )
    expect(run.toolRow('wait_agent')).toMatchObject({
      state: 'failed',
      input: { description: LABEL }
    })
  })

  it('registers the helper whichever order its first turn and its spawn arrive in', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      turn('turn/started', HELPER, HELPER_TURN),
      spawnCompleted
    )
    expect(run.agents()).toEqual([
      expect.objectContaining({ membership: 'live', state: 'working', description: LABEL })
    ])
    expect(run.strip()).toHaveLength(1)
  })

  it('ends a running helper its caller closed as cancelled, in the strip and the record together', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      closeCompleted
    )
    expect(run.agents()).toEqual([
      expect.objectContaining({ membership: 'settled', outcome: 'cancelled' })
    ])
    expect(run.strip()).toEqual([])
    expect(run.toolRow('close_agent')).toMatchObject({
      state: 'completed',
      input: { description: LABEL }
    })
  })

  it('leaves a finished helper finished when its caller closes it', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      turn('turn/completed', HELPER, HELPER_TURN),
      closeCompleted
    )
    expect(run.agents()).toEqual([
      expect.objectContaining({ membership: 'settled', outcome: 'succeeded' })
    ])
  })

  it('keeps one child for a session that announces the helper both ways', async () => {
    const run = await session()
    run.send(
      turn('turn/started', THREAD_ID, PARENT_TURN),
      activityStarted,
      spawnCompleted,
      turn('turn/started', HELPER, HELPER_TURN),
      { ...activityStarted, method: 'item/completed' }
    )
    // The activity landed first, so its task name labels the one child.
    expect(run.agents()).toEqual([expect.objectContaining({ description: 'sleeper' })])
    expect(run.strip()).toEqual([
      { id: `codex-agent:${HELPER}`, kind: 'agent', description: 'sleeper' }
    ])
    expect(run.rosterRows().at(-1)?.agents).toEqual([
      expect.objectContaining({ id: HELPER, label: 'sleeper' })
    ])
  })
})
