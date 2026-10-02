// Chats an earlier build left in per-chat files, on a real host, and the background copy job driven
// a run at a time on a clock the test moves; and a chat on that host that works meanwhile.

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  moveChatToPerChatFile,
  writePerChatJournalFile
} from '../agent-session-journal/journal-per-chat-file-test-support'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'
import { StructuredAgentSessionPerChatFileCopyPace } from './structured-agent-session-per-chat-file-copy-pace'
import {
  StructuredAgentSessionPerChatFileCopy,
  type PerChatFileCopyDeps
} from './structured-agent-session-per-chat-file-copy'
import {
  createRestTestRig,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { createStructuredAgentSessionStartupState } from './structured-agent-session-startup-state'
import { sessionTabListed } from './structured-agent-session-host-tabs'

export const COPY_TEST_WORKSPACE = 'workspace-1'

export type CopyTestRig = RestTestRig & { copyClock: { now: number } }

export async function createCopyTestRig(): Promise<CopyTestRig> {
  return Object.assign(await createRestTestRig(), { copyClock: { now: 0 } })
}

/** Creates each chat (listed unless told not to), sending one message so it has history. */
export async function createChats(
  rig: RestTestRig,
  ids: readonly string[],
  options: { listed?: boolean; message?: boolean } = {}
): Promise<void> {
  for (const sessionId of ids) {
    await restTestChat(rig, sessionId, {
      listed: options.listed !== false,
      ...(options.message === false ? {} : { message: `asked ${sessionId}` })
    })
  }
}

/** After a crash: moves each chat out of the host's database into its per-chat file. */
export function moveToPerChatFiles(rig: RestTestRig, ids: readonly string[]): void {
  const database = openTestJournalHostDatabase(rig.root)
  for (const sessionId of ids) {
    moveChatToPerChatFile(database, { sessionId, workspaceId: COPY_TEST_WORKSPACE })
  }
}

/** A per-chat file whose contents only a fake importer reads. */
export function writeStubPerChatFile(rig: RestTestRig, sessionId: string): string {
  const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  return writePerChatJournalFile(directory, sessionId, { epoch: 'stub', rows: [] })
}

export function hasPerChatFile(rig: RestTestRig, sessionId: string): boolean {
  const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  return existsSync(legacyJournalDatabaseFile(directory))
}

/** Every `journal.db` left under the old-file root. */
export async function perChatFilesLeft(rig: RestTestRig): Promise<number> {
  const root = perChatJournalRoot(rig.root)
  if (!existsSync(root)) {
    return 0
  }
  let files = 0
  for (const workspace of await readdir(root)) {
    for (const session of await readdir(join(root, workspace))) {
      files += existsSync(legacyJournalDatabaseFile(join(root, workspace, session))) ? 1 : 0
    }
  }
  return files
}

/** The job over the rig's current host, never started on a timer: a test calls `tick`. */
export function copyJob(
  rig: CopyTestRig,
  overrides: Partial<PerChatFileCopyDeps> = {}
): StructuredAgentSessionPerChatFileCopy {
  return new StructuredAgentSessionPerChatFileCopy({ ...copyJobDeps(rig), ...overrides })
}

/** The job's dependencies over the rig's current host. Its settle is the startup state's own,
 *  counted, and its rule for which chats this host settles is the rig adapter's. */
export function copyJobDeps(rig: CopyTestRig): PerChatFileCopyDeps {
  const { sessions, serialize } = rig.host.collaboratorsForTests()
  const database = openTestJournalHostDatabase(rig.root)
  // The rig adapter's own rule.
  const canSettle = (record: AgentSessionRecord | null): record is AgentSessionRecord =>
    record !== null && !rig.unsupportedWorkspaceIds.has(record.location.workspaceId)
  const startup = createStructuredAgentSessionStartupState({
    openDeps: {
      store: rig.store,
      adapter: {
        historyFilePath: ({ identity }) => rig.adapter.historyFilePath(identity.sessionId)
      },
      journalDatabase: database,
      logger: rig.host.deps.logger
    },
    canSettle,
    seedStatus: () => undefined,
    resolveRecovery: async () => true,
    restoreListed: async () => undefined,
    serialize,
    hasSession: (sessionId) => sessions.has(sessionId),
    isListed: (sessionId) => sessionTabListed(rig.store, sessionId),
    isDisposed: () => false
  })
  return {
    database,
    store: rig.store,
    listedIds: rig.store.getVisibleSessionTabIndex().sessionIds,
    isStartupChatWorkActive: () => false,
    // The host's own: its status feed's `working`.
    chatWork: rig.host['clientDelivery'].chatWork,
    serialize,
    openJournal: (sessionId) => sessions.get(sessionId)?.journal,
    settleClosedChat: vi.fn(startup.settleClosedChat),
    canSettle,
    isDisposed: () => false,
    logger: rig.host.deps.logger,
    now: () => rig.copyClock.now,
    appVersion: '1.0.0',
    freeBytes: async () => null,
    startDelayMs: 0,
    // On the job's clock: work the test charges by moving it is paced, and a wait moves it.
    pace: new StructuredAgentSessionPerChatFileCopyPace(
      () => rig.copyClock.now,
      async (ms) => {
        rig.copyClock.now += ms
      }
    )
  }
}

/** Ticks until the job has finished, a second of its clock apart; answers how many ticks it took. */
export async function runToEnd(
  rig: CopyTestRig,
  job: StructuredAgentSessionPerChatFileCopy,
  limit = 100
): Promise<number> {
  for (let ticks = 1; ticks <= limit; ticks += 1) {
    rig.copyClock.now += 1_000
    await job.tick()
    if (job.isFinished) {
      return ticks
    }
  }
  throw new Error(`the copy did not finish within ${limit} ticks`)
}

/** A chat open on the rig's host whose provider streams a turn, or takes a send it never answers.
 *  Each provider frame is noted on the sink first, as an adapter does at receipt. */
export type LiveTestChat = {
  /** A frame that writes no row: a streamed delta between the journal's checkpoints. */
  frame: () => void
  streamTurn: () => Promise<void>
  /** An approval the running turn waits on: the row reads `attention`, the turn still runs. */
  askUnderTurn: () => Promise<void>
  endTurn: () => Promise<void>
  sendUnanswered: () => Promise<void>
}

export async function openLiveChat(rig: RestTestRig, sessionId: string): Promise<LiveTestChat> {
  await restTestChat(rig, sessionId, { listed: false, message: 'first' })
  await rig.host.flushStreamedEvents(sessionId)
  const [{ events }] = rig.adapter.acquire.mock.calls.at(-1)!
  if (!events) {
    throw new Error(`no provider events for ${sessionId}`)
  }
  let ordinal = 1
  let turnId = ''
  const frame = () => {
    if (!events.noteProviderFrame) {
      throw new Error('the host sink takes no provider frames')
    }
    events.noteProviderFrame()
  }
  const provider = async (body: (turnId: string) => AgentJournalItemBody) => {
    frame()
    ordinal += 1
    const row = { provider: 'codex' as const, threadId: `thread-${sessionId}`, turnId, ordinal }
    events.appendItem(row, body(turnId), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    events.publish()
    await rig.host.flushStreamedEvents(sessionId)
  }
  // The first message's turn ends, so the chat is idle and its next send goes to the provider.
  const opened = await rig.adapter.dispatch.mock.results.at(-1)!.value
  if (opened.state === 'accepted') {
    turnId = opened.providerIdentity.turnId
    await provider((id) => ({ kind: 'turn', turnId: id, state: 'completed', outcome: 'success' }))
  }
  return {
    frame,
    streamTurn: async () => {
      turnId = `turn-live-${ordinal}`
      await provider((id) => ({ kind: 'turn', turnId: id, state: 'running' }))
    },
    askUnderTurn: () =>
      provider(() => ({
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      })),
    endTurn: () =>
      provider((id) => ({ kind: 'turn', turnId: id, state: 'completed', outcome: 'success' })),
    sendUnanswered: async () => {
      // Written and handed over; the provider has neither opened a turn for it nor answered it.
      rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
      const dispatched = rig.adapter.dispatch.mock.calls.length
      const sent = await sendRestTestMessage(rig, sessionId, 'and then')
      if (!sent.ok) {
        throw new Error(`send refused: ${sent.refusal.code}`)
      }
      await vi.waitFor(() =>
        expect(rig.adapter.dispatch.mock.calls.length).toBeGreaterThan(dispatched)
      )
      await rig.host.flushStreamedEvents(sessionId)
    }
  }
}
