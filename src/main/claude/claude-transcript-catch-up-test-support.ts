// Shared real disk/journal fixture for catch-up and historical-duration contracts.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, type Mock, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'

export const SESSION = 'session-claude-catch-up'
export const SID = '402eff2b-84dc-4e05-8fe8-49fffb2cd3c3'

/** One content block of a saved assistant row. */
type ClaudeContentPart = { type: string } & Record<string, unknown>

export const at = (n: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, n)).toISOString()
export const prompt = (uuid: string, parentUuid: string | null, text: string, n: number) => ({
  type: 'user',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  promptSource: 'cli',
  timestamp: at(n),
  message: { role: 'user', content: text }
})
export const reply = (
  uuid: string,
  parentUuid: string,
  messageId: string,
  part: ClaudeContentPart,
  n: number
) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  apiBlockIndex: 0,
  timestamp: at(n),
  message: { id: messageId, role: 'assistant', content: [part] }
})
export const attachment = (uuid: string, parentUuid: string) => ({
  type: 'attachment',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  attachment: { type: 'total_tokens_reminder' }
})
export const bookkeeping = [
  { type: 'last-prompt', leafUuid: 'x', sessionId: SID },
  { type: 'cost-state' }
]

/** The chat's own turn as Claude saves it; its reply is the streamed `msg_a`. */
export const chatTurn = [
  prompt('p1', null, 'ask 1', 1),
  attachment('t1', 'p1'),
  reply('a1', 't1', 'msg_a', { type: 'text', text: 'answer 1' }, 2),
  ...bookkeeping
]
/** A terminal turn on the same conversation: a prompt, a tool call and its result, then a reply. */
export const outsideTurn = [
  { type: 'queue-operation', operation: 'enqueue', sessionId: SID },
  prompt('p2', 'a1', 'ask 2', 3),
  attachment('t2', 'p2'),
  reply('a2', 't2', 'msg_b', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }, 4),
  {
    type: 'user',
    uuid: 'r2',
    parentUuid: 'a2',
    isSidechain: false,
    sessionId: SID,
    timestamp: at(5),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }]
    }
  },
  reply('a3', 'r2', 'msg_c', { type: 'text', text: 'answer 2' }, 6),
  ...bookkeeping
]

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

export async function chat(project = '-work', cwd = '/work') {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-catch-up-'))
  const projects = join(root, 'claude-home', 'projects', project)
  await mkdir(projects, { recursive: true })
  const transcript = join(projects, `${SID}.jsonl`)
  await writeFile(transcript, '')
  const identity = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(SID, 'a1')
  } satisfies AgentSessionJournalIdentity
  const journal = await journals.open({
    identity,
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const warn: Mock<(...args: unknown[]) => void> = vi.fn()
  return {
    identity,
    journal,
    replay: () => journals.open({ identity, stateDirectory: root, now: () => 1_000 }),
    warn,
    deferred,
    write: (rows: readonly Record<string, unknown>[]) =>
      appendFile(transcript, rows.map((row) => `${JSON.stringify(row)}\n`).join('')),
    /** The chat's own turn, sent and streamed live the way the SDK reports it. */
    live: async (
      options: { interrupted?: boolean; tool?: boolean; text?: string; thinking?: string } = {}
    ) => {
      const text = options.text ?? 'answer 1'
      await journal.appendSubmission({
        clientMessageId: 'send-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ask 1' }] },
        payloadFingerprint: 'send-1',
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: SID, uuid: 'p1' },
        fence: 1
      })
      const translator = createClaudeJournalTranslator({ sink: deferred.sink })
      const frame = (message: Record<string, unknown>) =>
        translator.handle({ type: 'message', sessionId: SESSION, message, observedAt: 2_000 })
      const stream = (uuid: string, event: Record<string, unknown>) =>
        frame({ type: 'stream_event', uuid, session_id: SID, parent_tool_use_id: null, event })
      stream('s1', { type: 'message_start', message: { id: 'msg_a' } })
      stream('s2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
      stream('s3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      })
      if (!options.interrupted) {
        frame({
          type: 'assistant',
          uuid: 'a1',
          session_id: SID,
          parent_tool_use_id: null,
          message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text }] }
        })
      }
      if (options.tool) {
        frame({
          type: 'assistant',
          uuid: 'call',
          session_id: SID,
          parent_tool_use_id: null,
          message: {
            id: 'call',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'original' } }
            ]
          }
        })
      }
      if (options.thinking) {
        stream('thought-start', { type: 'message_start', message: { id: 'msg_thought' } })
        stream('thought-block', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        })
        stream('thought-delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: options.thinking }
        })
      }
      if (options.interrupted) {
        translator.handle({ type: 'ended', sessionId: SESSION, reason: 'crash', observedAt: 3_000 })
      } else {
        frame({ type: 'result', subtype: 'success', session_id: SID, parent_tool_use_id: null })
      }
      translator.flush()
      translator.dispose()
      await deferred.drained()
    },
    open: async (
      leafUuid: string,
      options: Pick<
        Parameters<typeof catchUpClaudeTranscript>[0],
        'signal' | 'timeoutMs' | 'assertCurrent'
      > = {}
    ) => {
      const covered = await catchUpClaudeTranscript({
        sessionId: SESSION,
        providerSessionId: SID,
        leafUuid,
        claudeConfigDir: join(root, 'claude-home'),
        cwd,
        sink: deferred.sink,
        logger: { warn, error: vi.fn() },
        ...options
      })
      await deferred.drained()
      return covered
    },
    rows: () =>
      journal.snapshot().items.flatMap((item) => {
        const { body } = item
        if (body.kind === 'message') {
          const text = body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
          return [`${body.role}:${text.join('')}`]
        }
        if (body.kind === 'tool-call') {
          return [`tool:${body.name}:${body.state}`]
        }
        return body.kind === 'status' && body.presentation ? [`(${body.presentation})`] : []
      })
  }
}
