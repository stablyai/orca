import { observeNativeJournalTransactions } from '../native-chat/agent-session-journal/journal-native-test-instrumentation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  setTestLaterRowFailure
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'

const SESSION = 'codex-atomic'
const journals = createTrackedJournalOpener({ legacyInputs: true })
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back the entire Codex exit settlement when a later row fails', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-atomic-'))
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
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
  const published: ReturnType<typeof journal.snapshot>[] = []
  const publish = vi.fn(() => {
    published.push(journal.snapshot())
  })
  const commits = vi.fn()
  deferred.bind({ journal, fence: 7, publish })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
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
  for (let index = 0; index < 201; index++) {
    expect(
      translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: `call-${index}`,
            command: 'run',
            status: 'inProgress'
          }
        })
      )
    ).toEqual({ accepted: true })
  }
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  published.length = 0
  journal.observeCommits(commits)
  const before = journal.snapshot()
  const database = await openTestJournalHostDatabase(root)
  const diskBefore = await liveTestJournalRows(database, SESSION)
  const sawEarlierInserts: number[] = []
  onTestFinished(
    observeNativeJournalTransactions(database, (entry) => {
      if (entry.sql === 'ROLLBACK') {
        sawEarlierInserts.push(entry.rowInserts)
        expect(journal.snapshot()).toEqual(before)
        expect(commits).not.toHaveBeenCalled()
        expect(
          published.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(before))
        ).toBe(true)
      }
    })
  )
  await setTestLaterRowFailure(database, {
    sessionId: SESSION,
    afterSequence: before.cursor.sequence + 1
  })
  const ended = {
    type: 'ended' as const,
    sessionId: SESSION,
    reason: 'lost child',
    cause: 'unexpected-exit' as const,
    observedAt: 1_000,
    fence: 7,
    acquisitionGeneration: 'generation'
  }
  expect(translator.handle(ended)).toEqual({ accepted: true })
  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(sawEarlierInserts).toEqual([1])
  expect(await liveTestJournalRows(database, SESSION)).toEqual(diskBefore)
  expect(journal.snapshot()).toEqual(before)
  expect(commits).not.toHaveBeenCalled()
  expect(published.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(before))).toBe(
    true
  )
  translator.dispose()
  deferred.close()
})
