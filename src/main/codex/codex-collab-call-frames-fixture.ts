// Default-mode collab frames as a live session sent them, and the journal rows the real adapter
// publishes for them: what a client reads.

import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { fakeCodex, identityFor, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

// Shapes as a live default-mode session sent them (codex-cli 0.157); only the sender is remapped.
export const HELPER = '01a0ea72-80bc-7632-a97f-4a9a0d50d08f'
export const PARENT_TURN = 'parent-turn-1'
export const HELPER_TURN = 'helper-turn-1'
export const PROMPT = 'Run exactly one foreground shell command: `sleep 150; echo LATE`.'

export type Frame = { method: string; params: Record<string, unknown> }

export const turn = (
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  id: string
): Frame => ({
  method,
  params: { threadId, turn: { id, status: 'completed' } }
})
export const item = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  fields: Record<string, unknown>
): Frame => ({ method, params: { threadId, turnId, item: fields } })
export const collab = (
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
export const shell = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  id: string,
  output: string
): Frame =>
  item(method, threadId, turnId, {
    type: 'commandExecution',
    id,
    command: `/bin/zsh -lc 'echo ${output}'`,
    cwd: '/work/repo',
    status: method === 'item/started' ? 'inProgress' : 'completed',
    ...(method === 'item/completed' ? { exitCode: 0, aggregatedOutput: `${output}\n` } : {})
  })

export const spawn = (method: 'item/started' | 'item/completed'): Frame =>
  collab(method, {
    id: 'call-spawn',
    tool: 'spawnAgent',
    status: method === 'item/started' ? 'inProgress' : 'completed',
    receiverThreadIds: method === 'item/started' ? [] : [HELPER],
    prompt: PROMPT,
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    ...(method === 'item/completed'
      ? { agentsStates: { [HELPER]: { status: 'pendingInit', message: null } } }
      : {})
  })
export const waitStarted = collab('item/started', {
  id: 'call-wait',
  tool: 'wait',
  status: 'inProgress',
  receiverThreadIds: [HELPER]
})

export async function publishedRows(frames: Frame[]): Promise<AgentJournalRenderItem[]> {
  const codex = fakeCodex()
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
    now: () => 1_700_000_000_500
  })
  // The latest revision of each row, in first-written order, as a client's journal holds it.
  const rows = new Map<string, AgentJournalRenderItem>()
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      const itemId = JSON.stringify(identity)
      const previous = rows.get(itemId)
      const sequence = previous?.sequence ?? rows.size + 1
      const { agentId, parentAgentId, producerKind } = options
      rows.set(itemId, {
        ...previous,
        ...(agentId === undefined ? {} : { agentId }),
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        ...(producerKind === undefined ? {} : { producerKind }),
        itemId,
        sequence,
        revision: (previous?.revision ?? 0) + 1,
        observedAt: sequence,
        body
      })
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  for (const frame of frames) {
    codex.connections[0]!.handlers.onNotification?.(frame.method, frame.params)
  }
  return [...rows.values()]
}
