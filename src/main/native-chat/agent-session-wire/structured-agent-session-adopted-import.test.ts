import './structured-agent-session-question-import-replay.spec'
import * as fileVersions from '../transcript-file-version'
import type { AgentSessionCurrentRequestsRead } from '../../../shared/agent-session-current-requests-wire'
import * as sourceFiles from 'node:fs'
vi.mock('node:fs', async (original) => ({ ...(await original<typeof sourceFiles>()) }))
import * as transcriptFormats from '../agent-session-journal/journal-legacy-transcript-format'
import { MessageQuestionIngest } from '../message-question-ingest'
import * as lifecycle from '../message-question-lifecycle'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

import { appendFile, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { performAttach, type AttachFlowInput } from './structured-agent-session-attach-flow'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import * as legacyImport from '../agent-session-journal/journal-legacy-import'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  NO_STRUCTURED_AGENTS,
  structuredAgentsDeclaringNothing
} from './structured-agent-session-adapter-router-test-support'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { writeOpenCodeSqliteDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-fixture'

vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (importOriginal) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await importOriginal<object>()),
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})

const NOW = 1_800_000_000_000
const SESSION = 'codex_adopting_session'
const THREAD = 'adopted-thread'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null
let store: AgentSessionRecordStore | null = null

afterEach(async () => {
  if (root) {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
  root = null
  store = null
  vi.restoreAllMocks()
})

async function writeCodexRollout(path: string, text: string): Promise<void> {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: THREAD, timestamp: '2026-09-06T18:00:00.000Z', cwd: '/workspace' }
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-06T18:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: text
      }
    })
  ]
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function attachParams(
  transcriptPath?: string,
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    adopt: {
      providerHandle: codexProviderHandle(THREAD),
      ...(transcriptPath ? { transcriptPath } : {})
    },
    ...overrides
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    open: async () => ({
      reportedOptions: { model: '' }
    }),
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        acquisitionGeneration: globalThis.crypto.randomUUID(),
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'resumed-link',
          handle: codexProviderHandle(THREAD),
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
    // Proven release preserves the original failure instead of wrapping unproven exit.
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

async function attach(
  transcriptPath: string | undefined,
  sessionAdapter: StructuredAgentSessionAdapter,
  onAttached: AttachFlowInput['onAttached'] = () => {},
  params: AgentSessionAttachParams = attachParams(transcriptPath),
  agents = NO_STRUCTURED_AGENTS
) {
  store ??= await openTestAgentSessionRecordStore(root!)
  return performAttach({
    agents,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: sessionAdapter,
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(root!)),
    authority: {
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    params,
    now: () => NOW,
    onAttached
  })
}

describe('adopting a provider conversation on create', () => {
  it('seeds the chain from the adopted handle and fills the journal from its transcript', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-import-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'token ORCA-ADOPT-1')
    const sessionAdapter = adapter()

    const result = await attach(transcriptPath, sessionAdapter)

    expect(result).toMatchObject({ ok: true })
    // The seeded chain must resume the adopted conversation.
    const page = (result as { value: { page: { items: unknown[] } } }).value.page
    expect(JSON.stringify(page.items)).toContain('ORCA-ADOPT-1')
  })

  it.each([
    {
      agent: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/home/dev/.grok' },
      record: async (dir: string, text: string) => {
        const path = join(dir, 'chat_history.jsonl')
        await writeFile(
          path,
          `${JSON.stringify({ type: 'user', content: [{ type: 'text', text }] })}\n`
        )
        return path
      }
    },
    {
      agent: 'opencode',
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
      record: async (dir: string, text: string) => {
        const path = join(dir, 'opencode.db')
        writeOpenCodeSqliteDatabase(path, [
          { id: THREAD, turns: [{ role: 'user', parts: [text] }] }
        ])
        return path
      }
    },
    {
      agent: 'pi',
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/dev/.pi/agent' },
      record: async (dir: string, text: string) => {
        const path = join(dir, `2026-10-12T00-00-00-000Z_${THREAD}.jsonl`)
        const records = [
          { type: 'session', version: 3, id: THREAD, cwd: '/workspace' },
          { type: 'message', id: 'rec-1', parentId: null, message: { role: 'user', content: text } }
        ]
        await writeFile(path, `${records.map((line) => JSON.stringify(line)).join('\n')}\n`)
        return path
      }
    }
  ] as const)(
    "seeds a $agent chat's chain with the session it adopts and imports that CLI's history",
    async ({ agent, accountHome, record }) => {
      root = await mkdtemp(join(tmpdir(), `orca-adopt-${agent}-`))
      const transcriptPath = await record(root, `ORCA-${agent}-ADOPT`)
      const definition = structuredAgentRuntimeRegistration(agent)?.definition
      if (!definition) {
        throw new Error(`this build registers no ${agent} chats`)
      }
      // Pi handles name session files; other providers use conversation IDs.
      const handle = {
        transport: definition.handleTransport,
        agent,
        nativeId: agent === 'pi' ? transcriptPath : THREAD
      }
      const sessionAdapter = adapter()
      vi.mocked(sessionAdapter.acquire).mockImplementation(async ({ fence, spawnToken }) => ({
        acquisitionGeneration: `generation-${fence}`,
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'resumed-link',
          handle,
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }))

      const result = await attach(
        transcriptPath,
        sessionAdapter,
        () => {},
        attachParams(transcriptPath, {
          provider: agent,
          agent,
          accountHome,
          adopt: { providerHandle: handle, transcriptPath }
        }),
        structuredAgentsDeclaringNothing([definition])
      )

      expect(result.ok && JSON.stringify(result.value.page.items)).toContain(`ORCA-${agent}-ADOPT`)
      expect(store?.getRecord(SESSION)?.providerHandleChain[0]).toMatchObject({
        origin: 'adopted',
        handle
      })
    }
  )

  it('replays create without replacing journal-only messages or rereading the source', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-replay-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'original turn')
    const sessionAdapter = adapter()
    const first = await attach(transcriptPath, sessionAdapter, async ({ journal }) => {
      await journal.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: THREAD, recordId: 'journal-only' },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not yet in rollout' }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
    })
    expect(first.ok).toBe(true)
    await rm(transcriptPath)
    const replay = await attach(transcriptPath, sessionAdapter, async ({ journal }) =>
      journal.close()
    )
    expect(replay).toMatchObject({ ok: true, replayed: true })
    if (!first.ok || !replay.ok) {
      throw new Error('attach failed')
    }
    expect(replay.cursor.epoch).toBe(first.cursor.epoch)
    expect(JSON.stringify(replay.value.page.items)).toContain('not yet in rollout')
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'oversized', 'empty', 'invalid', 'source-less'] as const)(
    'refuses %s source before claiming a conversation',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'orca-adopt-preflight-'))
      const transcriptPath = join(root, 'rollout.jsonl')
      if (kind === 'oversized') {
        await writeCodexRollout(transcriptPath, 'original turn')
        await appendFile(transcriptPath, 'x'.repeat(16 * 1024 * 1024 + 1))
      } else if (kind === 'empty' || kind === 'invalid') {
        await writeFile(transcriptPath, kind === 'empty' ? '' : 'not json\n')
      }
      const sessionAdapter = adapter()
      const onAttached = vi.fn()
      const result = await attach(
        kind === 'source-less' ? undefined : transcriptPath,
        sessionAdapter,
        onAttached
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
      expect(sessionAdapter.releaseAcquisition).not.toHaveBeenCalled()
      expect(onAttached).not.toHaveBeenCalled()
      expect(store?.getRecord(SESSION)).toBeNull()
      expect(store?.listOperationRows()).toEqual([])
      if (kind === 'oversized') {
        expect(JSON.stringify(result)).toContain('byte limit')
      }
    }
  )

  it('still releases acquisition on an import write failure, and leaves the conversation open', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-write-failure-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'valid source')
    vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems').mockRejectedValueOnce(
      new Error('disk write failed')
    )
    const sessionAdapter = adapter()
    await expect(attach(transcriptPath, sessionAdapter)).rejects.toThrow('disk write failed')
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(sessionAdapter.releaseAcquisition).toHaveBeenCalledTimes(1)
  })

  it('leaves the conversation writable when the import fails after acquiring', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-host-failure-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'valid source')
    store = await openTestAgentSessionRecordStore(root)
    const host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems').mockRejectedValueOnce(
      new Error('disk write failed')
    )
    const attached = await host
      .attach({ callerKey: 'client-1' }, attachParams(transcriptPath))
      .catch(() => null)
    expect(attached?.ok).not.toBe(true)

    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    const sent = await host.send(
      { callerKey: 'client-1' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${NOW}-${'2'.padStart(32, '0')}`,
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    await host.flushAllStreamedEvents()
  })

  it('prepares a valid source once before acquisition and imports those exact items', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-adopt-once-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexRollout(transcriptPath, 'prepared before acquiring')
    const prepare = vi.spyOn(legacyImport, 'prepareLegacyTranscriptImport')
    const sessionAdapter = adapter()
    const acquire = sessionAdapter.acquire
    sessionAdapter.acquire = vi.fn(async (input) => {
      expect(prepare).toHaveBeenCalledTimes(1)
      await rm(transcriptPath)
      return acquire(input)
    })
    const result = await attach(transcriptPath, sessionAdapter, async ({ journal }) =>
      journal.close()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('attach failed')
    }
    expect(JSON.stringify(result.value.page.items)).toContain('prepared before acquiring')
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})

it.each([
  { mode: 'new', count: 2200, fault: 'none' },
  { mode: 'saved', count: 2200, fault: 'none' },
  { mode: 'saved', count: 22000, fault: 'none' },
  { mode: 'saved', count: 2200, fault: 'growth' },
  { mode: 'saved', count: 22000, fault: 'growth' },
  { mode: 'saved', count: 2200, fault: 'unreadable' },
  { mode: 'saved', count: 2200, fault: 'digest' }
])(
  'reconstructs complete at-rest questions for a $mode bounded import of $count rows with $fault source through actual source and piece owners',
  async ({ mode, count, fault }) => {
    root = await mkdtemp(join(tmpdir(), 'orca-async-bounded-import-'))
    const home = join(root, 'account')
    await mkdir(join(home, 'sessions'), { recursive: true })
    const transcriptPath = join(home, 'sessions', `rollout-2026-09-06T18-00-00-${THREAD}.jsonl`)
    const question = (id: string, label: string) =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          id,
          type: 'function_call',
          name: 'request_user_input_async',
          call_id: id,
          arguments: JSON.stringify({ questions: [{ title: id, options: [label, 'other'] }] })
        }
      })
    const large = 'full-definition-'.repeat(3000)
    const mixed = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Unrelated blocks do not shift accepted async-call slots' },
          { type: 'tool_use', name: 'shell', input: { command: 'pwd' } },
          {
            type: 'tool_use',
            id: 'early-q',
            name: 'request_user_input_async',
            input: { questions: [{ title: 'duplicate early call', options: ['skip'] }] }
          },
          {
            type: 'tool_use',
            name: 'request_user_input_async',
            input: { questions: [{ title: 'mixed first', options: [large] }] }
          },
          {
            type: 'tool_use',
            name: 'request_user_input_async',
            input: { questions: [{ title: 'mixed second', options: ['same text', 'other'] }] }
          }
        ]
      }
    })
    const prefix = [
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: root } }),
      question('answered-prefix', 'answered'),
      JSON.stringify({
        type: 'event_msg',
        payload: { id: 'prefix-human', type: 'user_message', message: 'delivered answer' }
      }),
      question('stopped-prefix', 'interrupted'),
      JSON.stringify({ type: 'event_msg', payload: { id: 'prefix-stop', type: 'turn_aborted' } }),
      question('early-q', 'early-choice')
    ]
    await writeFile(transcriptPath, `${prefix.join('\n')}\n`)
    // Distinct modest valid records evict the early row without exercising record-size rejection.
    for (let group = 0; group < count / 100; group++) {
      await appendFile(
        transcriptPath,
        `${Array.from({ length: 100 }, (_, offset) =>
          JSON.stringify({
            type: 'response_item',
            payload: {
              id: `ordinary-${group}-${offset}`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'working '.repeat(1200) }]
            }
          })
        ).join('\n')}\n`
      )
    }
    await appendFile(transcriptPath, `${mixed}\n${question('large-q', large)}\n`)
    const params = attachParams(transcriptPath, {
      accountHome: { variable: 'CODEX_HOME', path: home }
    })
    const sessionAdapter = adapter()
    store = await openTestAgentSessionRecordStore(root)
    const makeHost = () =>
      new StructuredAgentSessionHost({
        agents: NO_STRUCTURED_AGENTS,
        store,
        adapter: sessionAdapter,
        logger: createStructuredAgentSessionLogger(),
        journalDatabase: openTestJournalHostDatabase(root),
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => root!,
        now: () => NOW
      })
    let host = makeHost()
    if (mode === 'saved') {
      expect(await host.create({ callerKey: 'client-1' }, params)).toMatchObject({ ok: true })
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      store = await openTestAgentSessionRecordStore(root)
      host = makeHost()
    }
    const tail = `${question('large-q', large)}\n`
    const tailPosition = (await stat(transcriptPath)).size - Buffer.byteLength(tail)
    const writeTail = async (value: string) => {
      const file = await open(transcriptPath, 'r+')
      try {
        await file.write(value, tailPosition, 'utf8')
      } finally {
        await file.close()
      }
    }
    const originalRead = sourceFiles.createReadStream
    let sourcePasses = 0
    let sourceBytes = 0
    vi.spyOn(sourceFiles, 'createReadStream').mockImplementation((...args) => {
      const stream = originalRead(...args)
      if (String(args[0]) === transcriptPath) {
        sourcePasses++
        stream.on('data', (chunk: Buffer | string) => {
          sourceBytes += Buffer.byteLength(chunk)
        })
      }
      return stream
    })
    const originalFormat = transcriptFormats.resolveLegacyTranscriptFormat
    const ingestVisits = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const lifecycleVisits = vi.spyOn(lifecycle, 'reconcileMessageQuestionResolution')
    let decoderVisits = 0
    vi.spyOn(transcriptFormats, 'resolveLegacyTranscriptFormat').mockImplementation((agent) => {
      const format = originalFormat(agent)
      if (!format || format.transcriptAgent === 'opencode') {
        return format
      }
      return {
        ...format,
        decode: (line, fallback) => {
          decoderVisits++
          return format.decode(line, fallback)
        }
      }
    })
    let growthAppends = 0
    if (fault === 'growth') {
      const fingerprint = fileVersions.boundaryFingerprint
      vi.spyOn(fileVersions, 'boundaryFingerprint').mockImplementation(async (...args) => {
        const value = await fingerprint(...args)
        if (args[0] === transcriptPath) {
          await appendFile(
            transcriptPath,
            `${question(`growth-${growthAppends++}`, 'outside original')}\n`
          )
        }
        return value
      })
    }
    if (mode === 'new') {
      expect(await host.create({ callerKey: 'client-1' }, params)).toMatchObject({ ok: true })
    }
    // A provider append after import is outside its proven boundary and has no native journal fact.
    await appendFile(transcriptPath, `${question('not-imported', 'must not resurrect')}\n`)
    if (fault === 'unreadable') {
      await rename(transcriptPath, `${transcriptPath}.held`)
    }
    if (fault === 'digest') {
      await writeTail(`${question('large-q', large.replace('full', 'WRNG'))}\n`)
    }
    await host.history({ sessionId: SESSION, direction: 'tail' })
    const session = host.collaboratorsForTests().sessions.get(SESSION)!
    const journal = session.journal
    expect(JSON.stringify(journal.snapshot())).not.toContain('early-choice')
    const owner = journal.messageQuestions()
    if (mode === 'saved') {
      expect(owner.repository.current(owner.source).records).toEqual([])
    }
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const reads = vi.fn((request: AgentSessionCurrentRequestsRead) =>
      host.readCurrentRequests(request, 'agent-session.current-requests.v2')
    )
    const reader = createAgentSessionCurrentRequestsReader({
      read: reads,
      replaceMarker: (marker) => {
        state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker })
      },
      complete: (marker, items, payload) => {
        state = reduceStructuredAgentSession(state, {
          type: 'requests-complete',
          marker,
          items,
          payload
        })
      },
      error: (error) => {
        throw error
      }
    })
    const close = await host.subscribe({
      id: 'import-proof',
      sessionId: SESSION,
      boundedFrames: true,
      readsCurrentRequests: true,
      requestContract: 'agent-session.current-requests.v2',
      emit: (event) => {
        state = reduceStructuredAgentSession(state, { type: 'event', event })
        if (event.type !== 'end') {
          reader.observe(event.currentRequests)
        }
      }
    })
    try {
      if (fault === 'unreadable' || fault === 'digest') {
        await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2))
        expect(state.requestAuthority).toBeDefined()
        expect(state.asyncQuestionAuthority).toBeUndefined()
        expect(owner.repository.current(owner.source).records).toEqual([])
        // Restore only source readability/definition bytes; existing reader retry advances the owner.
        await (fault === 'unreadable'
          ? rename(`${transcriptPath}.held`, transcriptPath)
          : writeTail(tail))
      }
      await vi.waitFor(
        () =>
          expect(state.asyncQuestions?.map((record) => record.questions[0].question)).toEqual([
            'early-q',
            'mixed first',
            'mixed second',
            'large-q'
          ]),
        { timeout: 30_000 }
      )
      expect(state.asyncQuestions?.[1].questions[0].options[0].label).toBe(large)
      expect(state.asyncQuestions?.[3].questions[0].options[0].label).toBe(large)
      const mixedId = agentJournalItemKey({
        provider: 'legacy',
        agent: 'codex',
        sessionId: THREAD,
        recordId: `#${count + 6}`
      })
      expect(
        state.asyncQuestions
          ?.slice(1, 3)
          .map((record) => [record.sourceRowId, record.callSlot, record.timestamp])
      ).toEqual([
        [mixedId, 1, null],
        [mixedId, 2, null]
      ])
      const terminalPrefix = owner.repository
        .current(owner.source)
        .records.filter((record) => record.questions[0].question.endsWith('-prefix'))
      expect(
        terminalPrefix.map((record) => [record.questions[0].question, record.resolution.state])
      ).toEqual([
        ['answered-prefix', 'resolved'],
        ['stopped-prefix', 'cancelled']
      ])
      expect(state.asyncQuestionAuthority?.version).toBe(state.requestMarker?.version)
      if (fault === 'growth') {
        expect(growthAppends).toBeGreaterThan(0)
        expect(sourcePasses).toBe(1)
      }
      expect(reads.mock.calls.length).toBeGreaterThan(1)
      const visits = decoderVisits
      const ingests = ingestVisits.mock.calls.length
      const settlements = lifecycleVisits.mock.calls.length
      const passes = sourcePasses
      const bytes = sourceBytes
      const writes = vi.spyOn(owner.repository, 'reconcile')
      const projection = hostStructuredAgentSessionCurrentWork(
        { store: store!, sessions: host.collaboratorsForTests().sessions },
        SESSION
      )!.requestProjection(SESSION, 'agent-session.current-requests.v2')
      for (const fanout of [10, 100]) {
        for (let view = 0; view < fanout; view++) {
          await host.readCurrentRequests(
            { sessionId: SESSION, version: projection.marker.version, cursor: 0 },
            'agent-session.current-requests.v2'
          )
        }
      }
      expect(decoderVisits).toBe(visits)
      expect(ingestVisits).toHaveBeenCalledTimes(ingests)
      expect(lifecycleVisits).toHaveBeenCalledTimes(settlements)
      expect({
        passes: sourcePasses,
        bytes: sourceBytes,
        writes: writes.mock.calls.length
      }).toEqual({ passes, bytes, writes: 0 })
      expect(passes).toBeLessThanOrEqual(mode === 'new' || fault === 'digest' ? 2 : 1)
      expect(bytes).toBeGreaterThan(16 * 1024 * 1024)
      expect(ingests).toBeGreaterThan(6)
      expect(ingests).toBeLessThanOrEqual(20)
      expect(settlements).toBeGreaterThan(0)
      expect(settlements).toBeLessThanOrEqual(30)
      console.log('question-import-operations', {
        mode,
        count,
        fault,
        sourcePasses: passes,
        sourceBytes: bytes,
        decoderVisits: visits,
        ingestVisits: ingests,
        lifecycleVisits: settlements,
        fanoutReads: 110,
        unchangedReconciliations: writes.mock.calls.length
      })
      expect(visits).toBeGreaterThan(count)
      expect(visits).toBeLessThanOrEqual(
        (count + 10) * (mode === 'new' || fault === 'digest' ? 2 : 1)
      )
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
      expect(sessionAdapter.dispatch).not.toHaveBeenCalled()
      const ids = state.asyncQuestions!.map((record) => record.id)
      await host.cancelCurrentQuestions({ sessionId: SESSION, ids: [ids[0]] }, 'phone')
      await journal.appendItem(
        { provider: 'orca', clientMessageId: 'delivered-old-client-answer' },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'the full choice' }] },
        { fence: 1 }
      )
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(state.asyncQuestions).toEqual([]))
      expect(
        owner.repository
          .current(owner.source)
          .records.filter((record) => ids.includes(record.id))
          .map((record) => record.resolution.state)
      ).toEqual(['cancelled', 'resolved', 'resolved', 'resolved'])
      await host.close(SESSION, 'evict')
      await host.history({ sessionId: SESSION, direction: 'tail' })
      const reopened = hostStructuredAgentSessionCurrentWork(
        { store: store!, sessions: host.collaboratorsForTests().sessions },
        SESSION
      )!
      await vi.waitFor(
        () => {
          const payload = reopened.requestProjection(
            SESSION,
            'agent-session.current-requests.v2'
          ).items
          expect(payload && !Array.isArray(payload) && payload.asyncQuestions).toEqual([])
        },
        { timeout: 30_000 }
      )
      expect(
        owner.repository
          .current(owner.source)
          .records.filter((record) => ids.includes(record.id))
          .map((record) => record.id)
      ).toEqual(ids)
    } finally {
      close()
      reader.invalidate()
      await host.flushAllStreamedEvents()
    }
  },
  60_000
)
