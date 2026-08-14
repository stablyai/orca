import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../shared/structured-agent-session-reducer'
import { roomStructuredLifecycle } from '../runtime/rooms/machine-harness-session'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
function message(
  type: 'assistant' | 'user',
  uuid: string,
  content: unknown[],
  parentToolUseId: string | null = null
) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(type === 'user' && parentToolUseId === null ? { startsTurn: true as const } : {}),
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: { role: type, content }
    }
  }
}

function resultFrame(subtype: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype,
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      session_id: 'claude-session',
      uuid: `result-${subtype}`,
      ...fields
    }
  }
}

const JOURNAL_IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: 'leaf-1' }
}

let journalRoot = ''

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-claude-journal-translation-'))
})

afterEach(async () => {
  await rm(journalRoot, { recursive: true, force: true })
})

it('preserves Rooms duration and details through steer, interruption and the next turn', async () => {
  let now = 1_700_000_000_000
  const journal = await openAgentSessionJournal({
    identity: JOURNAL_IDENTITY,
    journalDir: journalRoot,
    now: () => now
  })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: vi.fn() })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink })
  const observe = () =>
    roomStructuredLifecycle({
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      items: journal.snapshot().items
    })
  translator.handle(message('user', 'root-1', [{ type: 'text', text: 'sleep 300' }]))
  translator.handle(message('assistant', 'comment-1', [{ type: 'text', text: 'Starting sleep' }]))
  translator.handle(
    message('assistant', 'command-1', [
      { type: 'tool_use', id: 'sleep-1', name: 'Bash', input: { command: 'sleep 300' } }
    ])
  )
  await deferred.drained()
  const startedAt = journal
    .snapshot()
    .items.find((item) => item.body.kind === 'status' && item.body.turnLifecycle)?.observedAt
  now += 20_000
  translator.handle({
    ...message('user', 'steer-1', [{ type: 'text', text: 'Confirm and continue' }]),
    startsTurn: undefined,
    turn: { turnId: 'root-1' }
  })
  await deferred.drained()
  expect(observe()).toMatchObject({ type: 'activity', turnId: 'root-1' })
  now += 15_000
  translator.handle(
    resultFrame('error_during_execution', { is_error: true, terminal_reason: 'aborted_tools' })
  )
  await deferred.drained()
  const stopped = observe()!
  expect(stopped).toMatchObject({ type: 'interrupted', turnId: 'root-1', timestamp: now })
  expect(stopped.timestamp - startedAt!).toBe(35_000)
  expect(JSON.stringify(stopped.messages)).toContain('Starting sleep')
  expect(JSON.stringify(stopped.messages)).toContain('sleep 300')
  now += 5_000
  translator.handle(message('user', 'root-2', [{ type: 'text', text: 'Reply OK' }]))
  translator.handle({
    ...message('user', 'late-old', [{ type: 'text', text: 'Old replay' }]),
    startsTurn: undefined,
    turn: { turnId: 'root-1' }
  })
  translator.handle(message('assistant', 'answer-2', [{ type: 'text', text: 'OK' }]))
  await deferred.drained()
  now += 4_000
  translator.handle(resultFrame('success', { is_error: false, result: 'OK' }))
  await deferred.drained()
  const completed = observe()!
  expect(completed).toMatchObject({ type: 'final', turnId: 'root-2', timestamp: now })
  expect(JSON.stringify(completed.messages)).not.toContain('Old replay')
  expect(JSON.stringify(completed.messages)).not.toContain('Starting sleep')
  expect(completed.messages.filter((item) => item.role === 'assistant')).toHaveLength(1)
  expect(
    journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'status' && item.body.turnLifecycle)
  ).toHaveLength(2)
  translator.dispose()
})
