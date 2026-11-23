import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import SyncDatabase from '../sqlite/sync-database'
import { mailRoot } from './bot-group-mail-root'
import { narrowGroupMailBatch } from './bot-group-peer-requests'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

const SESSION = 'bot-group-member-scout'
const report = (dispatchId: string) => ({
  id: `msg-${dispatchId}`,
  thread_id: null,
  from_handle: `dispatch:${dispatchId}`
})

const TURN = {
  botId: 'bot-0',
  botName: 'Scout',
  avatar: null,
  agent: 'claude',
  sessionId: SESSION
} as const

let directory: string
let db: OrchestrationDb
let roomDb: SyncDatabase
let runId: string

function open() {
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  roomDb = new SyncDatabase(join(directory, 'rooms.db'))
  const store = new BotGroupStore(roomDb)
  const runtime = { getOrchestrationDb: () => db }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mail narrowing reads only the room store and the orchestration DB.
  const groups = { store, runtime } as unknown as BotGroupRuntime
  return { store, groups }
}

function start(followUpOf?: string): string {
  return db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec: 'w',
    taskRunId: runId,
    startOptions: {},
    ...(followUpOf ? { followUpOf } : {})
  }).dispatch.id
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-room-follow-up-'))
})
afterEach(() => {
  db.close()
  roomDb.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Scout's room, where a human post's turn `op-1` started worker `first`. */
function room() {
  const { store, groups } = open()
  const group: BotGroup = {
    id: 'room-1',
    name: 'Release',
    hostId: 'local',
    revision: 1,
    folder: '/work/release',
    folderWorkspaceId: 'folder:release',
    createdAt: 0,
    members: [{ botId: 'bot-0', sessionId: SESSION }],
    replyMode: { kind: 'all' }
  }
  store.put(group)
  store.append({
    id: 'post-1',
    groupId: group.id,
    author: { kind: 'owner' },
    text: 'Ship it',
    createdAt: 0,
    turns: [{ ...TURN, operationId: 'op-1' }]
  })
  runId = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_c',
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: null
  }).id
  const first = start()
  store.bindWorker(first, 'op-1')
  return { groups, first }
}

describe("a room worker's follow-up reports", () => {
  it('wake the member that started the worker, down the whole follow-up chain', () => {
    const { groups, first } = room()
    const second = start(first)
    const third = start(second)
    for (const id of [first, second, third]) {
      expect(narrowGroupMailBatch(groups, SESSION, [report(id)]).messages).toEqual([report(id)])
    }
  })

  it('still wake it after a restart, from the stored lineage', () => {
    const { first } = room()
    const third = start(start(first))
    db.close()
    roomDb.close()
    const { groups } = open()
    expect(narrowGroupMailBatch(groups, SESSION, [report(third)]).messages).toEqual([report(third)])
  })

  it('serve the later request when a follow-up was started by a later turn', () => {
    const { groups, first } = room()
    groups.store.append({
      id: 'post-2',
      groupId: 'room-1',
      author: { kind: 'owner' },
      text: 'And the notes',
      createdAt: 1,
      turns: [{ ...TURN, operationId: 'op-2' }]
    })
    const second = start(first)
    groups.store.bindWorker(second, 'op-2')
    const member = groups.store.memberOf(SESSION)!.member
    expect(mailRoot(groups, 'room-1', member, report(start(second)))?.rootRequestId).toBe('post-2')
  })

  it('hold mail from a worker no room turn started, saying so once', () => {
    const { groups } = room()
    const stray = start()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let pass = 0; pass < 3; pass++) {
      expect(narrowGroupMailBatch(groups, SESSION, [report(stray)])).toEqual({
        messages: [],
        ended: []
      })
    }
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('wake the member after a Stop, as a request of their own, as the own chat does', () => {
    const { groups, first } = room()
    const stop = (throughLine = 'post-1') => {
      const group = groups.store.get('room-1')
      const through = groups.store.message(throughLine)!.sequence
      groups.store.put({
        ...group,
        members: group.members.map((member) => ({ ...member, stoppedThroughSequence: through }))
      })
    }
    stop()
    const later = report(start(first))
    expect(narrowGroupMailBatch(groups, SESSION, [later])).toEqual({ messages: [later], ended: [] })
    const member = groups.store.memberOf(SESSION)!.member
    expect(mailRoot(groups, 'room-1', member, later)?.rootRequestId).toBe(`reports:${SESSION}`)
    // A report already queued on a line when the Stop came is that line's request, which it ended.
    const queued = report(first)
    groups.store.append({
      id: `mail:${SESSION}:${queued.id}`,
      groupId: 'room-1',
      author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
      text: 'Scout followed up',
      createdAt: 2,
      turns: [{ ...TURN, operationId: 'op-mail' }]
    })
    stop(`mail:${SESSION}:${queued.id}`)
    expect(narrowGroupMailBatch(groups, SESSION, [queued])).toEqual({
      messages: [],
      ended: [queued.id]
    })
  })

  it("leave a bot's own chat mail untouched", () => {
    const { groups } = room()
    const mail = report(start())
    expect(narrowGroupMailBatch(groups, 'bot-chat-scout', [mail]).messages).toEqual([mail])
  })
})
