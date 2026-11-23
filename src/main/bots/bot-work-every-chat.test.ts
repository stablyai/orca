import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import SyncDatabase from '../sqlite/sync-database'
import { BotWorkRecord, type BotTurnAddress, type BotWorkWorker } from './bot-work-record'
import { prepareBotWorkerStart } from './bot-work-start'
import { BotWorkStore, botWorkStoreFile } from './bot-work-store'

const BOT = { id: 'bot-1', folderWorkspaceId: 'home-1' }
const HOME = { sessionId: 'home-chat', workspaceId: folderWorkspaceKey(BOT.folderWorkspaceId) }
const ROOM = { sessionId: 'bot-group-member-1', workspaceId: HOME.workspaceId }
const THREAD = { source: 'slack', externalId: 'T1:C1:1.0' } as const
const CHAT_NAMES: Record<string, string> = {
  'home-chat': 'Home',
  'bot-group-member-1': 'Release room'
}

function worker(dispatchId: string): BotWorkWorker {
  return {
    dispatchId,
    taskId: `task-${dispatchId}`,
    title: `work ${dispatchId}`,
    agent: 'claude',
    state: 'working',
    stopped: false,
    startFailed: false,
    host: 'local',
    hostName: null,
    worktreeId: null,
    startedAt: 1,
    settledAt: null
  }
}

describe('the work record across a bot chats', () => {
  const dirs: string[] = []
  const stores: BotWorkStore[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.dispose()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bot-work-chat-'))
    dirs.push(dir)
    return botWorkStoreFile(dir)
  }

  function setup(connectorTurn: BotTurnAddress | null = null) {
    const store = BotWorkStore.open(storePath())
    stores.push(store)
    const record = new BotWorkRecord({
      store: () => store,
      worker: async (dispatchId) => worker(dispatchId),
      workspace: async () => null,
      conversationTitle: (address) =>
        address.source === 'chat' ? (CHAT_NAMES[address.externalId] ?? null) : 'Slack thread',
      turnAddress: async (_sessionId, message) =>
        message.origin === 'connector' ? connectorTurn : null
    })
    const start = async (
      caller: { sessionId: string; workspaceId: string },
      dispatchId: string
    ): Promise<void> => {
      prepareBotWorkerStart(
        { bots: { list: () => [BOT] }, botWork: record, hostOf: () => 'local' },
        caller
      )({ taskId: `task-${dispatchId}`, dispatchId })
      await vi.waitFor(() =>
        expect(store.liveRows().some((row) => row.dispatchId === dispatchId)).toBe(true)
      )
    }
    return { store, record, start }
  }

  it('lists a worker started from the Home chat under that chat, with no reply address', async () => {
    const { store, record, start } = setup()
    record.handedOver(HOME.sessionId, {})
    await start(HOME, 'd-home')

    expect(store.liveRows('bot-1')[0]).toMatchObject({
      address: { source: 'chat', externalId: HOME.sessionId },
      askedInApp: true
    })
    expect(await record.list('bot-1')).toMatchObject([
      { dispatchId: 'd-home', source: { source: 'app', title: 'Home' } }
    ])
    // The chat's turn still names no conversation: no follow-up note, nothing to reply to.
    expect(await record.turnNote(HOME.sessionId, {})).toBeNull()
  })

  it('lists a worker started from a group room member chat', async () => {
    const { record, start } = setup()
    await start(ROOM, 'd-room')
    expect(await record.list('bot-1')).toMatchObject([
      { dispatchId: 'd-room', source: { source: 'app', title: 'Release room' } }
    ])
  })

  it('records a connector turn under its thread exactly as before', async () => {
    const turn = { botId: 'bot-1', address: THREAD }
    const { store, record, start } = setup(turn)
    record.handedOver(HOME.sessionId, { origin: 'connector' })
    await start(HOME, 'd-slack')

    expect(store.liveRows('bot-1')).toMatchObject([
      { address: THREAD, askedInApp: false, current: true, dispatchId: 'd-slack' }
    ])
    expect(await record.list('bot-1')).toMatchObject([
      { source: { source: 'slack', title: 'Slack thread' } }
    ])
    expect(await record.turnNote(HOME.sessionId, { origin: 'connector' })).toContain(
      'dispatch:d-slack'
    )
  })

  // Builds before chat rows read with the same rowOf, whose source list lacks 'chat': this is that
  // path with a source this build lacks. Their writes touch rows by id only (close, replace) or rows
  // rowOf returned (forgetBot), and their schema drops only indexes and other tables.
  it('skips and never touches a row whose source this build does not know', () => {
    const path = storePath()
    BotWorkStore.open(path).dispose()
    const raw = new SyncDatabase(path)
    raw.exec(`INSERT INTO bot_work (id, bot_id, source, external_id, generation, task_id,
        dispatch_id, host, created_at) VALUES ('later', 'bot-1', 'later-source', 'x', 1, 't', 'd',
        'local', 1)`)
    raw.close()

    const store = BotWorkStore.open(path)
    stores.push(store)
    const record = new BotWorkRecord({
      store: () => store,
      worker: async (dispatchId) => worker(dispatchId),
      workspace: async () => null,
      conversationTitle: () => null,
      turnAddress: async () => null
    })
    expect(store.liveRows()).toEqual([])
    record.forgetBot('bot-1')
    store.dispose()
    stores.pop()

    const check = new SyncDatabase(path)
    expect(check.prepare("SELECT closed_at FROM bot_work WHERE id = 'later'").all()).toEqual([
      { closed_at: null }
    ])
    check.close()
  })
})
