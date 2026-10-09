import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  settleStructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExitSession
} from '../native-chat/agent-session-wire/structured-agent-session-child-exit'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { pendingPromptExists } from '../native-chat/agent-session-wire/structured-agent-session-queued-messages'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { handleCodexSessionExit } from './codex-structured-session-close'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import { CODEX_COMMAND_APPROVAL_METHOD } from './codex-prompt-registry'

const SESSION = 'codex-exit-convergence'
const CALLS = 201
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

function userVisible(journal: AgentSessionJournal) {
  const items = journal.snapshot().items
  return {
    working: isStructuredAgentSessionMainAgentWorking(
      journal.activeTurnId(),
      journal.submissions(),
      8
    ),
    prompt: pendingPromptExists(journal),
    turnStates: items.flatMap((item) => readAgentJournalTurn(item.body)?.state ?? []),
    runningCalls: items.filter(
      (item) => item.body.kind === 'tool-call' && item.body.state === 'running'
    ).length,
    endedCalls: items.filter(
      (item) => item.body.kind === 'tool-call' && item.body.state !== 'running'
    ).length,
    send: journal.submission('send-1')?.dispatchState
  }
}

it('settles a refused Codex exit through the host in one commit, then permits a new send and reopens', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-exit-convergence-'))
  const options = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(options)
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'fp',
    fence: 7,
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  })
  await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'pending',
    fence: 7,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const recording = recordingStructuredAgentSessionLogger()
  const onFailed = vi.fn()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: SESSION,
    logger: recording.logger,
    onFailed,
    // Small budget exercises the production refusal without multi-megabyte fixtures.
    watermarks: { maxLifecycleQueuedBytes: 16_384 }
  })
  deferred.bind({ journal, fence: 7, publish: () => undefined })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => 'thread',
    now: () => 900
  })
  const notification = (method: string, params: unknown): CodexStructuredSessionEvent => ({
    type: 'notification',
    sessionId: SESSION,
    threadId: 'thread',
    method,
    params
  })
  expect(translator.handle(notification('turn/started', { turn: { id: 'turn' } }))).toEqual({
    accepted: true
  })
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  for (let index = 0; index < CALLS; index++) {
    expect(
      translator.handle(
        notification('item/started', {
          turnId: 'turn',
          item: {
            type: 'commandExecution',
            id: `call-${index}`,
            command: 'run',
            status: 'inProgress'
          }
        })
      )
    ).toEqual({ accepted: true })
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  expect(
    translator.handle({
      type: 'prompt',
      sessionId: SESSION,
      threadId: 'thread',
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'], turnId: 'turn' },
      codexItemId: 'call-0',
      promptKey: 'approval-1'
    })
  ).toEqual({ accepted: true })
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  expect(deferred.state().queuedBytes).toBe(0)
  expect(userVisible(journal)).toEqual({
    working: true,
    prompt: true,
    turnStates: ['running'],
    runningCalls: CALLS,
    endedCalls: 0,
    send: 'pending'
  })
  const before = journal.snapshot()
  const commits = vi.fn()
  journal.observeCommits(commits)
  const admission = vi.spyOn(translator, 'handle')
  const events: StructuredAgentSessionEndedEvent[] = []
  const codexSession: CodexSession = {
    connection: {
      pid: 4321,
      closed: true,
      request: async () => ({}),
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    ended: false,
    exitObservedAt: 1_000,
    fence: 7,
    acquisitionGeneration: 'generation',
    threadId: 'thread',
    translator,
    turnOpenWaits: createCodexTurnOpenWaits(),
    dispatchEchoes: createCodexDispatchEchoes(),
    backgroundTasks: new CodexBackgroundTaskTracker('thread'),
    prompts: new CodexPromptRegistry(),
    options: new Map(),
    reportedOptions: {}
  }
  expect(
    handleCodexSessionExit({
      sessions: new Map([[SESSION, codexSession]]),
      sessionId: SESSION,
      connection: codexSession.connection,
      error: new Error('codex exited'),
      logger: recording.logger,
      onEvent: (event) => {
        if (event.type === 'ended' && 'cause' in event) {
          events.push(event)
        }
      }
    })
  ).toBe(true)
  expect(admission).toHaveReturnedWith({ accepted: false, reason: 'backpressure' })
  expect(recording.entries).toContainEqual({
    level: 'warn',
    message: "Codex's final rows were refused; the host settles the turn instead",
    fields: { scope: 'codex-exit-rows', sessionId: SESSION, reason: 'backpressure' }
  })
  expect(codexSession.ended).toBe(true)
  expect(events).toHaveLength(1)
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  expect(onFailed).not.toHaveBeenCalled()
  expect(journal.snapshot()).toEqual(before)
  expect(commits).not.toHaveBeenCalled()
  let record: AgentSessionRecord = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: SESSION })
  )
  const hostSession: StructuredAgentSessionChildExitSession = {
    child: { generation: 'generation', fence: 7, phase: 'ready' },
    journal
  }
  const [event] = events
  if (!event) {
    throw new Error('Codex did not report its observed exit')
  }
  await settleStructuredAgentSessionChildExit(
    {
      logger: recording.logger,
      store: {
        getRecord: () => record,
        transitionHandoff: async (
          _sessionId: string,
          transition: (current: AgentSessionRecord) => AgentSessionRecord
        ) => (record = transition(record))
      },
      sessions: new Map([[SESSION, hostSession]]),
      flushLifecycle: () => deferred.lifecycleBarrier(),
      publishFence: vi.fn(),
      serialize: async (_sessionId, task) => task(),
      now: () => 5_000
    },
    event
  )
  expect(userVisible(journal)).toEqual({
    working: false,
    prompt: false,
    turnStates: ['interrupted'],
    runningCalls: 0,
    endedCalls: CALLS,
    send: 'unknown'
  })
  expect(commits).toHaveBeenCalledTimes(1)
  expect(journal.cursor().sequence - before.cursor.sequence).toBeGreaterThan(1)
  expect(record.lease.claimStatus).toBe('released')
  expect(hostSession.child).toBeNull()
  expect(recording.scopes()).not.toContain('exit-settlement')
  const sequence = journal.cursor().sequence + 1
  await expect(
    journal.appendSubmission({
      clientMessageId: 'send-2',
      payloadFingerprint: 'fp2',
      fence: 8,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'again' }] }
    })
  ).resolves.toMatchObject({ sequence })
  const settled = journal.snapshot()
  const submissions = journal.submissions()
  await journal.close()
  closeTestJournalHostDatabase(root)
  const reopened = await journals.open(options)
  expect(reopened.snapshot()).toEqual(settled)
  expect(reopened.submissions()).toEqual(submissions)
  deferred.close()
})
