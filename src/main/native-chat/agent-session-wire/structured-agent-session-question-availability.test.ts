import type * as ReactDomServer from 'react-dom/server'
import { MessageQuestionIngest } from '../message-question-ingest'
import { structuredQuestionImport } from './structured-agent-session-question-import'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { respondToStructuredAgentSessionPrompt } from '../../../renderer/src/components/native-chat/structured-agent-session-prompt-response'
import { setLocalRuntimeCapabilitiesForTests } from '../../../renderer/src/runtime/local-runtime-capabilities'
import { AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { useMobileStructuredPromptResponses } from '../../../../mobile/src/session/use-mobile-structured-prompt-responses'
import {
  projectStructuredPermission,
  projectStructuredQuestion
} from '../../../../mobile/src/session/mobile-structured-agent-prompts'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/structured-agent-session-coalescer'
import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import {
  hasCompleteBlockingRequests,
  currentMessageQuestionView
} from '../../../shared/agent-session-current-requests'
import {
  agentSessionPromptQuestions,
  encodeAgentSessionQuestionAnswers
} from '../../../shared/agent-session-question-answer'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { pendingStructuredSessionPrompts } from '../../../shared/structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { actionableStructuredPrompts } from '../../../../mobile/src/session/mobile-structured-actionable-prompt'
import {
  adapterFor,
  fakeCodex,
  THREAD_ID
} from '../../codex/codex-structured-session-adapter-fixture'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { invokeCanUseTool } from '../../claude/claude-can-use-tool-test-support'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'

const CALLER = { callerKey: 'client-1' }
const CONTRACT = 'agent-session.current-requests.v2'
const requireMobile = createRequire(new URL('../../../../mobile/package.json', import.meta.url))
const phoneRenderer: typeof ReactDomServer = requireMobile('react-dom/server')

it.each([
  ['codex', 'desktop'],
  ['codex', 'phone'],
  ['claude', 'desktop'],
  ['claude', 'phone']
] as const)(
  'keeps full %s blocking callbacks usable on %s during persistent async creation failure',
  async (agent, client) => {
    resetHostTestOperationIds()
    const root = await mkdtemp(join(tmpdir(), 'orca-question-availability-'))
    const store = await openTestAgentSessionRecordStore(root)
    const database = openTestJournalHostDatabase(root)
    const codex = fakeCodex()
    const claude = fakeClaude({ replayUuid: 'blocking-turn' })
    let host: StructuredAgentSessionHost
    const adapter =
      agent === 'codex'
        ? adapterFor(codex, {}, [], {
            onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
            onEvent: (event) => {
              if (
                event.type === 'options-reported' ||
                (event.type === 'ended' && 'cause' in event)
              ) {
                void host.handleAdapterEvent(event)
              }
            }
          })
        : new ClaudeStructuredSessionAdapter({
            resolveLaunch: async () => ({
              pathToClaudeCodeExecutable: 'claude',
              options: {},
              cwd: root,
              claudeConfigDir: join(root, 'claude-home'),
              providerSessionId: PROVIDER_SESSION_ID,
              resumeLeafUuid: null,
              resumesTranscript: false,
              continuesChain: false
            }),
            openConnection: claude.openConnection,
            readProcessStartTime: async () => 1_700_000_000_000,
            now: () => NOW,
            onEvent: (event) => {
              const mapped = structuredClaudeLifecycleEvent(event)
              if (mapped) {
                void host.handleAdapterEvent(mapped)
              }
            },
            onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement)
          })
    codex.routes['turn/start'] = (params) => {
      const connection = codex.connections[0]
      connection.handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'blocking-turn' }
      })
      connection.handlers.onNotification?.('item/completed', {
        threadId: THREAD_ID,
        turnId: 'blocking-turn',
        item: {
          type: 'userMessage',
          id: 'user-start',
          clientId: params?.clientUserMessageId,
          content: []
        }
      })
      return { turn: { id: 'blocking-turn' } }
    }
    host = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      store,
      adapter: Object.assign(adapter, { supportsCreate: () => true }),
      journalDatabase: database,
      logger: createStructuredAgentSessionLogger(),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-1',
      now: () => NOW
    })
    const envelope = (method: string, fields: Record<string, unknown>) => ({
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId: SESSION,
        fields
      })
    })
    const closes: (() => void)[] = []
    const readers: ReturnType<typeof createAgentSessionCurrentRequestsReader>[] = []
    const coalescers: ReturnType<typeof createStructuredAgentSessionEventCoalescer>[] = []
    let failed = false
    let ingestFailure: string | undefined
    const originalCurrent = MessageQuestionIngest.prototype.current
    const probe = vi.spyOn(MessageQuestionIngest.prototype, 'current').mockImplementation(function (
      ...args
    ) {
      try {
        return originalCurrent.apply(this, args)
      } catch (error) {
        ingestFailure = error instanceof Error ? error.stack : String(error)
        throw error
      }
    })
    try {
      expect(
        await host.attach(
          CALLER,
          hostTestAttachParams(
            null,
            agent === 'codex'
              ? { providerHandle: undefined }
              : {
                  provider: 'claude',
                  agent: 'claude',
                  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
                  providerHandle: undefined
                }
          )
        )
      ).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
      )
      const body = hostTestMessage('start work')
      expect(
        await host.send(CALLER, {
          body,
          envelope: envelope('agentSession.send', { body }),
          userSend: true
        })
      ).toMatchObject({ ok: true })
      await vi.waitFor(async () =>
        expect(
          (await host.journalSnapshot(SESSION)).submissions.some(
            (send) => send.dispatchState === 'accepted'
          )
        ).toBe(true)
      )
      const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const views = await Promise.all(
        ['desktop', 'phone'].map(async (name) => {
          let state = EMPTY_STRUCTURED_AGENT_SESSION
          let frames = 0
          const reader = createAgentSessionCurrentRequestsReader({
            read: (request) => host.readCurrentRequests(request, CONTRACT),
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
          readers.push(reader)
          const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
            state = reduceStructuredAgentSession(state, { type: 'event', event })
          })
          coalescers.push(coalescer)
          let close = () => {}
          const open = async () => {
            close = await host.subscribe({
              id: name,
              sessionId: SESSION,
              boundedFrames: true,
              readsCurrentRequests: true,
              requestContract: CONTRACT,
              emit: (event) => {
                frames++
                coalescer.push(event)
                if (event.type !== 'end' && event.currentRequests) {
                  reader.observe(event.currentRequests)
                }
              }
            })
            closes.push(close)
          }
          await open()
          return {
            state: () => state,
            frames: () => frames,
            flush: coalescer.flush,
            reopen: async () => {
              coalescer.flush()
              close()
              await open()
            },
            prompts: () =>
              name === 'phone'
                ? actionableStructuredPrompts(state)
                : pendingStructuredSessionPrompts({ journalItems: state.items, ...state })
          }
        })
      )
      await vi.waitFor(() =>
        views.forEach((view) => {
          const state = view.state()
          expect(
            currentMessageQuestionView(state)?.ready,
            JSON.stringify({
              ingestFailure,
              marker: state.requestMarker,
              authority: state.asyncQuestionAuthority,
              blocking: state.requestAuthority,
              origin: journal.historyOrigin(),
              chain: store.getRecord(SESSION)?.providerHandleChain,
              imported: structuredQuestionImport(
                journal,
                journal
                  .snapshot()
                  .items.map((item) => ({ item, fence: journal.itemFence(item.itemId) }))
              ),
              rows: journal
                .snapshot()
                .items.map((item) => [item.itemId, journal.itemFence(item.itemId), item.body.kind]),
              repository: journal
                .messageQuestions()
                .repository.current(journal.messageQuestions().source),
              payload: hostStructuredAgentSessionCurrentWork(
                { store, sessions: host.collaboratorsForTests().sessions },
                SESSION
              )!.requestProjection(SESSION, CONTRACT).items
            })
          ).toBe(true)
        })
      )
      database.db.exec(
        "CREATE TEMP TRIGGER fail_async_creation BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated async creation failure'); END"
      )
      failed = true
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD_ID, turnId: 'async', ordinal: 1 },
        asyncQuestionBody(),
        { fence: 1 }
      )
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() =>
        views.forEach((view) => {
          expect(hasCompleteBlockingRequests(view.state())).toBe(true)
          expect(currentMessageQuestionView(view.state())?.ready).toBe(false)
        })
      )
      const before = views.map((view) => view.frames())
      const approvalDone =
        agent === 'claude'
          ? invokeCanUseTool(claude.connections[0], 'Bash', 'approve', 'bash-tool', {
              input: { command: 'git status' }
            })
          : null
      if (agent === 'codex') {
        codex.connections[0].handlers.onServerRequest?.({
          id: 501,
          method: 'item/commandExecution/requestApproval',
          params: {
            itemId: 'approve',
            threadId: THREAD_ID,
            turnId: 'blocking-turn',
            command: 'git status'
          }
        })
      }
      const questionDone =
        agent === 'claude'
          ? invokeCanUseTool(claude.connections[0], 'AskUserQuestion', 'question', 'ask-tool', {
              input: {
                questions: [
                  { question: 'Which branch?', options: [{ label: 'main' }, { label: 'topic' }] },
                  { question: 'Which region?', options: [{ label: 'west' }, { label: 'east' }] }
                ]
              }
            })
          : null
      if (agent === 'codex') {
        codex.connections[0].handlers.onServerRequest?.({
          id: 502,
          method: 'item/tool/requestUserInput',
          params: {
            itemId: 'question',
            threadId: THREAD_ID,
            turnId: 'blocking-turn',
            questions: [
              {
                id: 'branch',
                question: 'Which branch?',
                options: [{ label: 'main' }, { label: 'topic' }]
              },
              {
                id: 'region',
                question: 'Which region?',
                options: [{ label: 'west' }, { label: 'east' }]
              }
            ]
          }
        })
      }
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() =>
        views.forEach((view) => expect(view.prompts().length).toBe(agent === 'codex' ? 3 : 2))
      )
      // Evict the definitions from both loaded histories; only the operational read can supply them.
      let lastOutputId: string | undefined
      for (let i = 0; i < 1100; i++) {
        const output = await journal.appendItem(
          { provider: 'orca', clientMessageId: `later-${i}` },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `later ${i}` }] },
          { fence: 1 }
        )
        lastOutputId = output.itemId
      }
      await host.flushStreamedEvents(SESSION)
      for (const view of views) {
        view.flush()
        const version = view.state().requestMarker?.version
        const cursor = journal.cursor()
        await view.reopen()
        await vi.waitFor(() => {
          expect(view.state().cursor).toEqual(cursor)
          expect(view.state().items.some((item) => item.itemId === lastOutputId)).toBe(true)
          expect(view.state().items.length).toBeLessThanOrEqual(200)
          expect(view.state().requestMarker?.version).toBe(version)
        })
      }
      for (const [index, view] of views.entries()) {
        expect(view.frames()).toBeGreaterThan(before[index])
        expect(
          view
            .state()
            .items.some((item) => item.body.kind === 'approval' || item.body.kind === 'question')
        ).toBe(false)
        expect(hasCompleteBlockingRequests(view.state())).toBe(true)
        expect(currentMessageQuestionView(view.state())?.ready).toBe(false)
        expect(
          view
            .prompts()
            .flatMap((item) =>
              item.body.kind === 'question'
                ? agentSessionPromptQuestions(item.body).map((q) => q.question)
                : []
            )
        ).toEqual(['Which branch?', 'Which region?'])
      }
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
      const clientView = views[client === 'desktop' ? 0 : 1]
      const dispatch = async (
        method: string,
        fingerprintMethod: string,
        fields: Record<string, unknown>
      ) => {
        expect(currentMessageQuestionView(clientView.state())?.ready).toBe(false)
        expect(hasCompleteBlockingRequests(clientView.state())).toBe(true)
        const result = await host.respondToPrompt(CALLER, {
          ...fields,
          kind: method === 'agentSession.respondToApproval' ? 'approval' : 'question',
          envelope: envelope(fingerprintMethod, fields)
        })
        expect(result).toMatchObject({ ok: true })
        if (!result.ok) {
          throw new Error('Actual prompt mutation refused')
        }
        return result.value
      }
      const desktopMutate = vi.fn()
      desktopMutate.mockImplementation(dispatch)
      const mobileMutate = vi.fn()
      mobileMutate.mockImplementation(async (...args: Parameters<typeof dispatch>) => ({
        status: 'accepted',
        sameFence: true,
        value: await dispatch(...args)
      }))
      let phone!: ReturnType<typeof useMobileStructuredPromptResponses>
      const onSendError = vi.fn()
      function PhoneResponses() {
        phone = useMobileStructuredPromptResponses({
          stateRef: {
            get current() {
              return clientView.state()
            }
          },
          mutate: mobileMutate,
          questionAnswersSupported: true,
          onSendError
        })
        return null
      }
      phoneRenderer.renderToString(createElement(PhoneResponses))
      const prompts = clientView.prompts()
      for (const prompt of prompts) {
        const selected = clientView.prompts().find((item) => item.itemId === prompt.itemId)!
        const answers =
          selected.body.kind === 'question'
            ? agentSessionPromptQuestions(selected.body).map((question) => ({
                questionId: question.id,
                optionIds: [question.options[0].id]
              }))
            : []
        if (client === 'desktop') {
          expect(
            await respondToStructuredAgentSessionPrompt({
              item: selected,
              response:
                selected.body.kind === 'approval'
                  ? { kind: 'option', optionId: selected.body.options[0].id }
                  : { kind: 'answers', answers },
              action: { target: { kind: 'local' }, mutate: desktopMutate, write: vi.fn() }
            })
          ).not.toBeNull()
        } else if (selected.body.kind === 'approval') {
          const permission = projectStructuredPermission({ ...selected, body: selected.body })!
          expect(permission.options.map((option) => option.label)).toEqual(
            selected.body.options.map((option) => option.label)
          )
          expect(await phone.respondPermission(permission.options[0].send)).toBe(true)
        } else {
          const question = projectStructuredQuestion({ ...selected, body: selected.body })!
          expect(question.questions?.map((q) => q.question) ?? [question.question]).toEqual(
            agentSessionPromptQuestions(selected.body).map((q) => q.question)
          )
          const response = selected.body.questions
            ? encodeAgentSessionQuestionAnswers(answers)
            : question.optionTokens![0]
          expect(await phone.respondQuestion(response, question.prompt)).toBe(true)
        }
      }
      expect(onSendError).not.toHaveBeenCalled()
      expect(client === 'desktop' ? desktopMutate : mobileMutate).toHaveBeenCalledTimes(
        prompts.length
      )
      if (agent === 'codex') {
        expect(
          codex.connections[0].replies.filter((reply) => reply.id === 501 || reply.id === 502)
        ).toHaveLength(2)
        expect(codex.connections[0].replies.find((reply) => reply.id === 502)?.result).toEqual({
          answers: { branch: { answers: ['main'] }, region: { answers: ['west'] } }
        })
      } else {
        await expect(approvalDone!.promise).resolves.toMatchObject({ behavior: 'allow' })
        await expect(questionDone!.promise).resolves.toMatchObject({ behavior: 'allow' })
        expect(approvalDone!.settled()).toBe(true)
        expect(questionDone!.settled()).toBe(true)
      }
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => views.forEach((view) => expect(view.prompts()).toEqual([])))
      expect(currentMessageQuestionView(views[0].state())?.ready).toBe(false)
      database.db.exec('DROP TRIGGER fail_async_creation')
      failed = false
      // No new provider event or source bytes: the existing reader's retry must advance the real source.
      await vi.waitFor(
        () =>
          views.forEach((view) =>
            expect(currentMessageQuestionView(view.state())?.ready).toBe(true)
          ),
        { timeout: 35_000 }
      )
      expect(views[0].state().asyncQuestions).toHaveLength(1)
    } finally {
      probe.mockRestore()
      if (failed) {
        database.db.exec('DROP TRIGGER fail_async_creation')
      }
      setLocalRuntimeCapabilitiesForTests(null)
      readers.forEach((reader) => reader.invalidate())
      closes.forEach((close) => close())
      coalescers.forEach((coalescer) => coalescer.dispose())
      await adapter.closeAll()
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)

it.each([10, 100])(
  'backs off stable unknown reads without publication churn or repeated source decoding across %i viewers',
  async (count) => {
    const rig = await createQueuedMessageTestRig()
    const readers: ReturnType<typeof createAgentSessionCurrentRequestsReader>[] = []
    const closes: (() => void)[] = []
    const database = openTestJournalHostDatabase(rig.root)
    let failed = false
    try {
      await rig.workingSend()
      const journal = currentJournal(rig)
      const work = currentWork(rig)
      work.requestProjection(SESSION, CONTRACT)
      database.db.exec(
        "CREATE TEMP TRIGGER fail_async_creation BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated async creation failure'); END"
      )
      failed = true
      await journal.appendItem(
        { provider: 'codex', threadId: 'async-thread', turnId: 'async', ordinal: 1 },
        asyncQuestionBody(),
        { fence: 1 }
      )
      await rig.host.flushStreamedEvents(SESSION)
      vi.useFakeTimers()
      const publication = work.requestProjection(SESSION, CONTRACT)
      expect(
        publication.items && !Array.isArray(publication.items) && publication.items.asyncQuestions
      ).toBe(null)
      const sourcePass = vi.spyOn(journal, 'visitItems')
      const submissions = vi.spyOn(journal, 'submissions')
      const reconcile = vi.spyOn(journal.messageQuestions().repository, 'reconcile')
      const times: number[] = []
      let commits = 0
      const started = Date.now()
      for (let i = 0; i < count; i++) {
        let state = EMPTY_STRUCTURED_AGENT_SESSION
        const reader = createAgentSessionCurrentRequestsReader({
          read: (request) => {
            if (i === 0) {
              times.push(Date.now() - started)
            }
            return rig.host.readCurrentRequests(request, CONTRACT)
          },
          replaceMarker: (marker) => {
            state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker })
          },
          complete: (marker, items, payload) => {
            const next = reduceStructuredAgentSession(state, {
              type: 'requests-complete',
              marker,
              items,
              payload
            })
            if (next !== state) {
              commits++
            }
            state = next
          },
          error: (error) => {
            throw error
          }
        })
        readers.push(reader)
        closes.push(
          await rig.host.subscribe({
            id: `unknown-${i}`,
            sessionId: SESSION,
            readsCurrentRequests: true,
            requestContract: CONTRACT,
            emit: (event) => {
              state = reduceStructuredAgentSession(state, { type: 'event', event })
              if (event.type !== 'end' && event.currentRequests) {
                reader.observe(event.currentRequests)
              }
            }
          })
        )
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(commits).toBe(count)
      sourcePass.mockClear()
      submissions.mockClear()
      reconcile.mockClear()
      for (const delay of [750, 1500, 3000, 6000, 12000, 24000, 30000, 30000]) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        const before = times.length
        await vi.advanceTimersByTimeAsync(1)
        expect(times).toHaveLength(before + 1)
        expect(work.requestProjection(SESSION, CONTRACT).marker).toBe(publication.marker)
      }
      expect(times.slice(1).map((time, index) => time - times[index])).toEqual([
        750, 1500, 3000, 6000, 12000, 24000, 30000, 30000
      ])
      expect(sourcePass).not.toHaveBeenCalled()
      expect(submissions).not.toHaveBeenCalled()
      expect(commits).toBe(count)
      // Viewer and chunk count do not multiply repair work: one eligible source attempt per retry instant.
      expect(reconcile.mock.calls.length).toBeLessThanOrEqual(8)
      database.db.exec('DROP TRIGGER fail_async_creation')
      failed = false
      await vi.advanceTimersByTimeAsync(30000)
      expect(work.requestProjection(SESSION, CONTRACT).marker.version).not.toBe(
        publication.marker.version
      )
      expect(commits).toBe(count * 2)
      const repaired = reconcile.mock.calls.length
      await vi.advanceTimersByTimeAsync(60000)
      expect(reconcile).toHaveBeenCalledTimes(repaired)
    } finally {
      readers.forEach((reader) => reader.invalidate())
      closes.forEach((close) => close())
      vi.useRealTimers()
      vi.restoreAllMocks()
      if (failed) {
        database.db.exec('DROP TRIGGER fail_async_creation')
      }
      await rig.dispose()
    }
  },
  60_000
)
