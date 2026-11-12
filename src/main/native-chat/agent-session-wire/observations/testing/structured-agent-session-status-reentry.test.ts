import { StructuredAgentSessionJournalProjections } from '../structured-agent-session-status-journal-projection'
import type { JournalWorkAuthority } from '../../../agent-session-journal/journal-observer-read'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionHandleProvider } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { AgentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session.test-fixture'
import { StructuredAgentSessionStatusFeed } from '../structured-agent-session-status-feed'

import type { StructuredAgentSessionStatusSink } from '../structured-agent-session-status-ownership'
import { createStructuredAgentSessionLogger } from '../../host/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const SESSION = 'reenter-session'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-reentry-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function openJournal(): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(root, SESSION)
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  return journal
}

async function createFeed() {
  const journal = await openJournal()
  const session = indexedStatusFeedSession({ journal })
  const sessions = new Map<
    string,
    {
      journal: AgentSessionJournal
      params: { location: AgentSessionExecutionLocation; provider: AgentSessionHandleProvider }
    }
  >([[SESSION, session]])
  const server = new AgentHookServer()
  const statusSink: StructuredAgentSessionStatusSink = {
    publish: vi.fn((summary, subject) => server.ingestStructuredStatus(summary, subject)),
    forget: vi.fn((subject) => server.dropStructuredStatus(subject))
  }
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions,
    getConversation: () => null,
    now: () => 1_000,
    statusSink: () => statusSink
  })
  await feed.publish(SESSION)
  expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  return { session, sessions, server, statusSink, feed }
}

describe('structured status canonical owner re-entry', () => {
  it('re-admits an unchanged session after its exact subject was forgotten', async () => {
    const { session, sessions, server, statusSink, feed } = await createFeed()
    sessions.delete(SESSION)
    feed.forget(SESSION)
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    const publishedBeforeReentry = vi.mocked(statusSink.publish).mock.calls.length
    sessions.set(SESSION, session)

    await feed.publish(SESSION)

    expect(statusSink.publish).toHaveBeenCalledTimes(publishedBeforeReentry + 1)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: expect.any(String), prompt: 'hello' })
    ])
  })

  it('moves an unchanged projection to a new trusted execution scope', async () => {
    const { session, sessions, server, statusSink, feed } = await createFeed()
    sessions.set(SESSION, {
      ...session,
      params: {
        ...session.params,
        location: { ...session.params.location, executionHostId: 'ssh:second-host' }
      }
    })

    await feed.publish(SESSION)

    expect(statusSink.forget).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executionHostId: 'local', sessionId: SESSION })
    )
    expect(statusSink.publish).toHaveBeenCalledTimes(2)
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ executionHostId: 'ssh:second-host' })
      })
    ])
  })
})

it('discards row-free authority changes before publishing an asynchronous observer answer', async () => {
  const journal = await openJournal()
  const projections = new StructuredAgentSessionJournalProjections()
  let revision = 0
  let contextId: string | null = null
  let attached = true
  const held: string[] = []
  const capture = () => {
    if (!attached) {
      return null
    }
    const authority: JournalWorkAuthority = {
      handle: journal.observationHandle(),
      record: {
        currentFence: 1,
        ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
      },
      child: { fence: 1, heldSends: held },
      handingOver: [],
      continuingUnadmitted: [],
      finalizing: [],
      openedThrough: journal.openingCursor(),
      reopenFloor: null,
      operationalRevision: revision,
      stopRevision: 0,
      stop: null
    }
    return { authority, contextId }
  }
  const narrow = await projections.readWorkSql(journal, capture)
  expect(narrow?.result.kind).toBe('state')
  expect(projections.currentSql(journal, capture())).toBeNull()
  expect(projections.savedStop(journal, null)).toBeUndefined()
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'work-turn' },
    { kind: 'turn', turnId: 'work-turn', state: 'running' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(await projections.readWorkSql(journal, capture)).toMatchObject({
    cursor: journal.cursor(),
    result: { kind: 'state', state: { latestTurn: { turn: { state: 'running' } } } }
  })
  expect(narrow?.cursor).not.toEqual(journal.cursor())
  attached = false
  expect(await projections.readWorkSql(journal, capture)).toBeNull()
  attached = true
  const reattachFailure = new Error('reattached work read failed')
  vi.spyOn(journal.reads, 'work').mockRejectedValueOnce(reattachFailure)
  await expect(projections.readWorkSql(journal, capture)).rejects.toBe(reattachFailure)
  await projections.readWorkSql(journal, capture)
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = journal.reads.observer.bind(journal.reads)
  const observer = vi.spyOn(journal.reads, 'observer').mockImplementation(async (input) => {
    const result = await read(input)
    reached.resolve()
    await release.promise
    return result
  })
  const invalidated: string[] = []
  const observed: unknown[] = []
  const pending = Promise.all(
    ['first', 'second'].map((reader) =>
      projections.readSql(
        journal,
        capture,
        () => invalidated.push(reader),
        (projection) => observed.push(projection)
      )
    )
  )
  await reached.promise
  revision = 1
  held.push('new-live-owner')
  release.resolve()
  expect(await pending).toEqual([null, null])
  expect(invalidated).toEqual(['first', 'second'])
  expect(observed).toEqual([])
  observer.mockRestore()
  const current = await projections.readSql(journal, capture, () => {})
  expect(current).toMatchObject({
    workRevision: 1,
    authority: { child: { heldSends: ['new-live-owner'] } }
  })
  await projections.readWorkSql(journal, capture)
  expect(projections.currentSql(journal, capture())).toBe(current)
  expect(projections.savedStop(journal, null)).toEqual({ value: null })
  held.push('later-owner')
  expect(current?.authority?.child?.heldSends).toEqual(['new-live-owner'])
  const refreshedWork = await projections.readWorkSql(journal, capture)
  expect(await projections.readWorkSql(journal, capture)).toEqual(refreshedWork)
  expect(projections.savedStop(journal, null)).toBeUndefined()
  expect(await projections.readSql(journal, capture, () => {})).toMatchObject({
    authority: { child: { heldSends: ['later-owner', 'new-live-owner'] } }
  })
  contextId = 'reopened-context'
  const contextWork = await projections.readWorkSql(journal, capture)
  expect(await projections.readWorkSql(journal, capture)).toEqual(contextWork)
  expect(projections.currentSql(journal, capture())).toBeNull()
  expect(projections.savedStop(journal, contextId)).toBeUndefined()
  await projections.readSql(journal, capture, () => {})
  revision = 2
  const failed = Promise.withResolvers<Awaited<ReturnType<typeof read>>>()
  const failure = new Error('observer read failed')
  vi.spyOn(journal.reads, 'observer').mockImplementationOnce(() => failed.promise)
  const failures = Promise.allSettled([
    projections.readSql(journal, capture, () => {}),
    projections.readSql(journal, capture, () => {})
  ])
  failed.reject(failure)
  expect(await failures).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure }
  ])
  expect(await projections.readSql(journal, capture, () => {})).toMatchObject({ workRevision: 2 })
  revision = 3
  const workEntered = Promise.withResolvers<void>()
  const workRelease = Promise.withResolvers<void>()
  const workRead = journal.reads.work.bind(journal.reads)
  vi.spyOn(journal.reads, 'work').mockImplementationOnce(async (input) => {
    const answer = await workRead(input)
    workEntered.resolve()
    await workRelease.promise
    return answer
  })
  const pendingWork = projections.readWorkSql(journal, capture)
  await workEntered.promise
  const published = await projections.readSql(journal, capture, () => {})
  workRelease.resolve()
  await pendingWork
  expect(projections.currentSql(journal, capture())).toBe(published)
  expect(projections.savedStop(journal, contextId)).toEqual({ value: null })
})
