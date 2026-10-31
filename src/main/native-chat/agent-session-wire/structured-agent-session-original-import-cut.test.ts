import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import {
  writeOpenCodeSqliteDatabase,
  appendOpenCodeSqliteTurn
} from '../../ai-vault/session-scanner-opencode-sqlite-fixture'
import * as pages from '../transcript-opencode-sqlite-query'
import * as importBoundary from './structured-agent-session-question-import-boundary'
import * as importFold from './structured-agent-session-question-import-fold'
import * as adoptedSource from '../agent-session-journal/adopted-transcript-source'
import * as openCodeTranscript from '../transcript-opencode'
import { PiRpcMessages } from '../../pi/rpc-messages'
import { PiRpcContextUsage } from '../../pi/rpc-context-usage'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { currentMessageQuestionView } from '../../../shared/agent-session-current-requests'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { structuredAgentsDeclaringNothing } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  hostTestAttachParams,
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

const account = vi.hoisted(() => ({ database: '' }))
vi.mock('../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: () => ({ OPENCODE_DB: account.database })
  })
}))
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    readOpenCodeTranscriptPageViaWorker: (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
let root: string | undefined
let host: StructuredAgentSessionHost | undefined
const releases: (() => void)[] = []
type TimedObservation = {
  startedElapsedMs: number
  endedElapsedMs?: number
  elapsedMs?: number
}
type ImportAttempt = TimedObservation & {
  attempt: number
  received: number
  accepted: number
  result?: 'complete' | 'refused'
  refusal?: string
}
type OriginalCutObservation = {
  agent: string
  fault: string
  startedAt: number
  phase: string
  attempts: ImportAttempt[]
  attemptCount: number
  pageReads: number
  pageCompletions: number
  pagePhase?: string
  pageElapsedMs?: number
  pageItems?: number
  pageRefusal?: string
  phases: Partial<
    Record<'corpus-write' | 'original-create' | 'cold-reopen' | 'subscription', TimedObservation>
  >
  sourceSteps: (TimedObservation & {
    owner: string
    result?: 'complete' | 'refused'
    value?: 'present' | 'absent'
    refusal?: string
  })[]
}
let observation: OriginalCutObservation | undefined
afterEach(async () => {
  const cleanupStartedAt = Date.now()
  let cleanupCompleted = false
  console.info(
    'original-cut-observation',
    JSON.stringify({
      ...observation,
      phase: 'cleanup-start',
      priorPhase: observation?.phase,
      elapsedMs: observation && Date.now() - observation.startedAt
    })
  )
  try {
    releases.splice(0, releases.length, ...releases.toReversed())
    releases.forEach((release) => release())
    releases.length = 0
    await host?.flushAllStreamedEvents()
    if (root) {
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
    root = undefined
    host = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    cleanupCompleted = true
  } finally {
    console.info(
      'original-cut-observation',
      JSON.stringify({
        ...observation,
        phase: 'cleanup-ended',
        cleanupCompleted,
        cleanupElapsedMs: Date.now() - cleanupStartedAt,
        elapsedMs: observation && Date.now() - observation.startedAt
      })
    )
    observation = undefined
  }
})

it.each(
  ['pi', 'opencode'].flatMap((agent) =>
    ['growth', 'missing', 'edited'].map((fault) => ({ agent, fault }))
  )
)(
  'admits only original $agent branch/anchor during $fault through host and shared reader',
  async ({ agent, fault }) => {
    if (agent !== 'pi' && agent !== 'opencode') {
      throw new Error('Expected registered agent')
    }
    const progress: OriginalCutObservation = {
      agent,
      fault,
      startedAt: Date.now(),
      phase: 'setup',
      attempts: [],
      attemptCount: 0,
      pageReads: 0,
      pageCompletions: 0,
      phases: {},
      sourceSteps: []
    }
    observation = progress
    const finishObservation = (entry: TimedObservation) => {
      entry.endedElapsedMs = Date.now() - progress.startedAt
      entry.elapsedMs = entry.endedElapsedMs - entry.startedElapsedMs
    }
    const startPhase = (name: keyof OriginalCutObservation['phases']) => {
      const entry: TimedObservation = { startedElapsedMs: Date.now() - progress.startedAt }
      progress.phases[name] = entry
      return () => finishObservation(entry)
    }
    const startSource = (owner: string) => {
      const step: OriginalCutObservation['sourceSteps'][number] = {
        owner,
        startedElapsedMs: Date.now() - progress.startedAt
      }
      progress.sourceSteps.push(step)
      if (progress.sourceSteps.length > 8) {
        progress.sourceSteps.shift()
      }
      return step
    }
    const observeSource = async <T>(owner: string, read: () => Promise<T>): Promise<T> => {
      const step = startSource(owner)
      try {
        const result = await read()
        step.result = 'complete'
        return result
      } catch (error) {
        step.result = 'refused'
        step.refusal = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        finishObservation(step)
      }
    }
    if (agent === 'opencode') {
      const signal = pages.readOpenCodeTranscriptSignal
      vi.spyOn(pages, 'readOpenCodeTranscriptSignal').mockImplementation((...args) => {
        const step = startSource('signal-query')
        try {
          const result = signal(...args)
          step.result = 'complete'
          step.value = result ? 'present' : 'absent'
          return result
        } catch (error) {
          step.result = 'refused'
          step.refusal = error instanceof Error ? error.message : String(error)
          throw error
        } finally {
          finishObservation(step)
        }
      })
    }
    root = await mkdtemp(join(tmpdir(), 'orca-original-cut-'))
    const sessions = join(root, 'sessions')
    await mkdir(sessions)
    vi.stubEnv('PI_CODING_AGENT_DIR', sessions)
    const path =
      agent === 'pi'
        ? join(sessions, `2026-10-12T00-00-00-000Z_${THREAD}.jsonl`)
        : join(root, 'opencode.db')
    const label = 'full original option '.repeat(2000)
    const input = { questions: [{ title: 'original question', options: [label] }] }
    progress.phase = 'write-original-corpus'
    const endCorpus = startPhase('corpus-write')
    const piRows = [
      { type: 'session', version: 3, id: THREAD, cwd: root },
      {
        type: 'message',
        id: 'original-question',
        parentId: null,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'request_user_input_async', arguments: input }]
        }
      },
      {
        type: 'message',
        id: 'original-anchor',
        parentId: 'original-question',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              name: 'request_user_input_async',
              arguments: { questions: [{ title: 'original anchor', options: [label] }] }
            }
          ]
        }
      }
    ]
    try {
      if (agent === 'pi') {
        await writeFile(path, `${piRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
      } else {
        account.database = path
        writeOpenCodeSqliteDatabase(path, [
          {
            id: THREAD,
            directory: root,
            turns: [
              ...Array.from({ length: 600 }, () => ({
                role: 'assistant' as const,
                parts: ['ordinary']
              })),
              {
                role: 'assistant',
                parts: [{ type: 'tool', tool: 'request_user_input_async', input }]
              }
            ]
          }
        ])
      }
    } finally {
      endCorpus()
    }
    const definition = structuredAgentRuntimeRegistration(agent)!.definition
    const adapter: StructuredAgentSessionAdapter = {
      open: async () => ({ reportedOptions: { model: '' } }),
      acquire: async () => {
        throw new Error('At-rest proof must not launch a provider')
      },
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    }
    let store = await openTestAgentSessionRecordStore(root)
    const makeHost = () =>
      new StructuredAgentSessionHost({
        now: () => HOST_TEST_NOW,
        agents: structuredAgentsDeclaringNothing([definition]),
        store,
        adapter,
        journalDatabase: openTestJournalHostDatabase(root!),
        logger: createStructuredAgentSessionLogger(),
        claimKeyId: 'key',
        resolveWorkspacePath: async () => root!
      })
    host = makeHost()
    const params = hostTestAttachParams(null, {
      provider: agent,
      agent,
      providerHandle: undefined,
      accountHome:
        agent === 'pi'
          ? { variable: 'PI_CODING_AGENT_DIR', path: root }
          : {
              kind: 'opencode',
              locator: { kind: 'managed', managedProfileId: '11111111-1111-4111-8111-111111111111' }
            },
      adopt: {
        providerHandle: {
          transport: definition.handleTransport,
          agent,
          nativeId: agent === 'pi' ? path : THREAD
        },
        transcriptPath: path
      }
    })
    progress.phase = 'original-import-create'
    const endCreate = startPhase('original-create')
    const created = await host.create({ callerKey: 'client' }, params).finally(endCreate)
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true })
    if (agent === 'pi') {
      expect(
        store.getRecord(SESSION)?.providerHandleChain.find((link) => link.origin === 'adopted')
          ?.handle
      ).toEqual({
        transport: definition.handleTransport,
        agent: 'pi',
        nativeId: path
      })
      expect(store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
    }
    progress.phase = 'cold-close-and-reopen'
    const endReopen = startPhase('cold-reopen')
    try {
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      store = await openTestAgentSessionRecordStore(root)
      host = makeHost()
    } finally {
      endReopen()
    }
    progress.phase = 'original-source-change'
    const attemptsBySignal = new WeakMap<AbortSignal, ImportAttempt>()
    const reconstruct = importBoundary.reconstructImport
    vi.spyOn(importBoundary, 'reconstructImport').mockImplementation(async (...args) => {
      const attempt: ImportAttempt = {
        attempt: ++progress.attemptCount,
        received: 0,
        accepted: 0,
        startedElapsedMs: Date.now() - progress.startedAt
      }
      progress.attempts.push(attempt)
      if (progress.attempts.length > 6) {
        progress.attempts.shift()
      }
      attemptsBySignal.set(args[4], attempt)
      try {
        const result = await reconstruct(...args)
        attempt.result = 'complete'
        return result
      } catch (error) {
        attempt.result = 'refused'
        attempt.refusal = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        finishObservation(attempt)
      }
    })
    const createFold = importFold.createQuestionImportFold
    vi.spyOn(importFold, 'createQuestionImportFold').mockImplementation((...args) => {
      const fold = createFold(...args)
      const attempt = attemptsBySignal.get(args[2])
      return {
        ...fold,
        accept: (...values) => {
          if (attempt) {
            attempt.received++
          }
          fold.accept(...values)
          if (attempt) {
            attempt.accepted++
          }
        }
      }
    })
    // Change only the registered original source, after the journal froze its original import.
    let pageReads = 0
    if (agent === 'pi') {
      const original = await readFile(path, 'utf8')
      await (fault === 'growth'
        ? appendFile(
            path,
            `${JSON.stringify({
              type: 'message',
              id: 'new-branch',
              parentId: null,
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    name: 'request_user_input_async',
                    arguments: { questions: [{ title: 'unimported fork', options: ['outside'] }] }
                  }
                ]
              }
            })}\n`
          )
        : writeFile(
            path,
            fault === 'missing'
              ? `${piRows
                  .slice(0, 2)
                  .map((row) => JSON.stringify(row))
                  .join('\n')}\n`
              : original.replaceAll('full original option', 'EDIT original option')
          ))
    } else {
      const importer = structuredAgentRuntimeRegistration(agent)!.transcriptImport!
      const find = importer.findTranscript
      const admit = importer.admitTranscriptPath
      const validate = adoptedSource.validateAdoptedOpenCodeSource
      const full = openCodeTranscript.readOpenCodeNativeChatTranscriptFull
      vi.spyOn(importer, 'findTranscript').mockImplementation((args) =>
        observeSource('find-transcript', () => find(args))
      )
      vi.spyOn(importer, 'admitTranscriptPath').mockImplementation((args) =>
        observeSource('admit-path', () => admit(args))
      )
      vi.spyOn(adoptedSource, 'validateAdoptedOpenCodeSource').mockImplementation((...args) =>
        observeSource('validate-source', () => validate(...args))
      )
      vi.spyOn(openCodeTranscript, 'readOpenCodeNativeChatTranscriptFull').mockImplementation(
        (...args) => observeSource('read-full', () => full(...args))
      )
      const read = pages.readOpenCodeTranscriptPage
      vi.spyOn(pages, 'readOpenCodeTranscriptPage').mockImplementation((args) => {
        const pageStartedAt = Date.now()
        progress.pagePhase = 'read-start'
        pageReads++
        progress.pageReads = pageReads
        try {
          if (pageReads === 1) {
            if (fault === 'growth') {
              const result = read(args)
              progress.pageCompletions++
              progress.pageItems = result?.items.length
              appendOpenCodeSqliteTurn(path, THREAD, {
                role: 'assistant',
                parts: [
                  {
                    type: 'tool',
                    tool: 'request_user_input_async',
                    input: { questions: [{ title: 'unimported newer', options: ['outside'] }] }
                  }
                ]
              })
              return result
            }
            const db = new SyncDatabase(path)
            try {
              if (fault === 'missing') {
                db.exec(
                  'DELETE FROM part WHERE message_id = (SELECT id FROM message ORDER BY rowid DESC LIMIT 1); DELETE FROM message WHERE rowid = (SELECT MAX(rowid) FROM message)'
                )
              } else {
                db.exec(
                  "UPDATE part SET data = replace(data, 'full original option', 'EDIT original option')"
                )
              }
            } finally {
              db.close()
            }
          }
          const result = read(args)
          progress.pageCompletions++
          progress.pageItems = result?.items.length
          return result
        } catch (error) {
          progress.pageRefusal = error instanceof Error ? error.message : String(error)
          throw error
        } finally {
          progress.pagePhase = 'read-ended'
          progress.pageElapsedMs = Date.now() - pageStartedAt
        }
      })
    }
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const reader = createAgentSessionCurrentRequestsReader({
      read: (request) => host!.readCurrentRequests(request, 'agent-session.current-requests.v2'),
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
    releases.push(reader.invalidate)
    progress.phase = 'subscribe-and-acquire'
    const endSubscribe = startPhase('subscription')
    releases.push(
      await host
        .subscribe({
          id: 'original-cut',
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
        .finally(endSubscribe)
    )
    if (fault === 'growth') {
      progress.phase = 'positive-original-publication'
      await vi.waitFor(() => expect(currentMessageQuestionView(state)?.ready).toBe(true), {
        timeout: 10_000
      })
      expect(state.asyncQuestions?.map((record) => record.questions[0].question)).toEqual(
        agent === 'pi' ? ['original question', 'original anchor'] : ['original question']
      )
      expect(state.asyncQuestions?.[0].questions[0].options[0].label).toBe(label)
      if (agent === 'opencode') {
        expect(pageReads).toBe(2)
      }
      expect(
        progress.attempts.some((attempt) => attempt.result === 'complete' && attempt.accepted > 0)
      ).toBe(true)
    } else {
      progress.phase = 'negative-original-refusal'
      await vi.waitFor(() => expect(state.requestAuthority).toBeDefined())
      await new Promise((resolve) => setTimeout(resolve, 800))
      expect(currentMessageQuestionView(state)?.ready).toBe(false)
      expect(state.asyncQuestions).not.toBeDefined()
      const expectedRefusal =
        fault === 'edited'
          ? 'Original question definition does not match saved import'
          : 'Original question source changed during reconstruction'
      expect(
        progress.attempts.some(
          (attempt) =>
            attempt.result === 'refused' &&
            attempt.received > 0 &&
            attempt.refusal === expectedRefusal
        ),
        JSON.stringify(progress)
      ).toBe(true)
    }
    if (agent === 'pi') {
      progress.phase = 'later-native-definition'
      const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const native = new PiRpcMessages('after-adoption', new PiRpcContextUsage()).tool({
        type: 'tool_execution_end',
        toolCallId: 'later-native',
        toolName: 'request_user_input_async',
        args: { questions: [{ title: 'later native Pi', options: ['native full value'] }] },
        isError: false
      })[0]
      if (native.type !== 'item.close') {
        throw new Error('Expected native Pi tool definition')
      }
      const beforeNative = state.requestAuthority?.version
      const appended = await journal.appendItem(
        { provider: 'legacy', agent: 'pi', sessionId: SESSION, recordId: native.item },
        native.body,
        {
          fence: store.getRecord(SESSION)!.lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
      await host.flushStreamedEvents(SESSION)
      expect(journal.item(appended.itemId)?.body).toEqual(native.body)
      if (fault === 'growth') {
        await vi.waitFor(() => {
          expect(state.requestAuthority?.version).toBeDefined()
          expect(state.requestAuthority?.version).not.toBe(beforeNative)
        })
        await vi.waitFor(
          () =>
            expect(state.asyncQuestions?.map((record) => record.questions[0].question)).toEqual([
              'original question',
              'original anchor',
              'later native Pi'
            ]),
          { timeout: 10_000 }
        )
        expect(currentMessageQuestionView(state)?.ready).toBe(true)
        expect(state.asyncQuestions?.at(-1)).toMatchObject({
          sourceRowId: appended.itemId,
          questions: [{ options: [{ label: 'native full value' }] }]
        })
      } else {
        const projection = hostStructuredAgentSessionCurrentWork(
          { store, sessions: host.collaboratorsForTests().sessions },
          SESSION
        )!.requestProjection(SESSION, 'agent-session.current-requests.v2')
        expect(projection.marker.version).toBe(beforeNative)
        expect(projection.items).toEqual({
          blocking: [],
          asyncQuestions: null,
          context: { sessionId: SESSION, boundary: 'root' }
        })
        const piece = await host.readCurrentRequests(
          { sessionId: SESSION, version: projection.marker.version, cursor: 0 },
          'agent-session.current-requests.v2'
        )
        expect(piece).toMatchObject({ marker: projection.marker, nextCursor: null })
        expect(JSON.parse(piece.json)).toEqual(projection.items)
        expect(currentMessageQuestionView(state)?.ready).toBe(false)
        expect(state.asyncQuestions).not.toBeDefined()
      }
    }
    progress.phase = 'assertions-complete'
    expect(adapter.dispatch).not.toHaveBeenCalled()
  },
  30_000
)
