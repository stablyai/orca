import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { BotWorkStore, botWorkStoreFile, type BotWorkBind } from './bot-work-store'

const THREAD = { source: 'slack', externalId: 'T1:C1:1.0' } as const

function bind(overrides: Partial<BotWorkBind> = {}): BotWorkBind {
  return {
    botId: 'bot-1',
    address: THREAD,
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    host: 'local',
    ...overrides
  }
}

describe('BotWorkStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps one live row per address and numbers each new one', () => {
    const store = BotWorkStore.open(':memory:')
    const first = store.bind(bind())
    expect(first?.generation).toBe(1)
    expect(store.bind(bind({ dispatchId: 'dispatch-2' }))).toBeNull()
    expect(store.live('bot-1', THREAD)?.dispatchId).toBe('dispatch-1')

    expect(first && store.close(first, 'stopped')).toBe(true)
    const second = store.bind(bind({ dispatchId: 'dispatch-2' }))
    expect(second?.generation).toBe(2)
    expect(store.live('bot-1', THREAD)?.rowId).toBe(second?.rowId)
  })

  it('closes by compare-and-swap, so a stale ref never closes a newer row', () => {
    const store = BotWorkStore.open(':memory:')
    const first = store.bind(bind())!
    expect(store.close(first, 'stopped')).toBe(true)
    expect(store.close(first, 'task_gone')).toBe(false)
    const second = store.bind(bind())!
    expect(store.close({ rowId: second.rowId, generation: first.generation }, 'stopped')).toBe(
      false
    )
    expect(store.live('bot-1', THREAD)?.rowId).toBe(second.rowId)
  })

  it('replaces a live row in one step, and leaves it live when the swap loses', () => {
    const store = BotWorkStore.open(':memory:')
    const first = store.bind(bind())!
    const next = store.replace(first, bind({ dispatchId: 'dispatch-2' }))
    expect(next?.generation).toBe(2)
    expect(store.replace(first, bind({ dispatchId: 'dispatch-3' }))).toBeNull()
    expect(store.live('bot-1', THREAD)?.dispatchId).toBe('dispatch-2')
  })

  it('leaves the old row live when Orca dies between the close and the new row', () => {
    const store = BotWorkStore.open(':memory:')
    const first = store.bind(bind())!
    store.bind = () => {
      throw new Error('killed')
    }
    expect(() => store.replace(first, bind({ dispatchId: 'dispatch-2' }))).toThrow('killed')
    expect(store.live('bot-1', THREAD)?.rowId).toBe(first.rowId)
  })

  it('keeps a replaced row live beside the current one', () => {
    const store = BotWorkStore.open(':memory:')
    const first = store.bind(bind())!
    const second = store.replace(first, bind({ dispatchId: 'dispatch-2' }))!
    expect(store.addressRows('bot-1', THREAD).map((row) => [row.dispatchId, row.current])).toEqual([
      ['dispatch-2', true],
      ['dispatch-1', false]
    ])
    expect(store.isOpen(first)).toBe(true)
    expect(store.live('bot-1', THREAD)?.rowId).toBe(second.rowId)
  })

  it('keeps rows across a reopen of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-work-'))
    dirs.push(dir)
    const path = botWorkStoreFile(dir)
    BotWorkStore.open(path).bind(bind())
    const reopened = BotWorkStore.open(path)
    expect(reopened.live('bot-1', THREAD)?.generation).toBe(1)
    expect(reopened.bind(bind())).toBeNull()
  })

  it('opens a file an earlier build wrote, before current rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-work-'))
    dirs.push(dir)
    const path = botWorkStoreFile(dir)
    const old = new SyncDatabase(path)
    old.exec(`
      CREATE TABLE bot_work (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
        generation INTEGER NOT NULL, task_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
        host TEXT NOT NULL, pr_watch INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
        closed_at INTEGER, close_reason TEXT, UNIQUE (bot_id, source, external_id, generation));
      CREATE UNIQUE INDEX bot_work_live_address
        ON bot_work (bot_id, source, external_id) WHERE closed_at IS NULL;
      INSERT INTO bot_work (id, bot_id, source, external_id, generation, task_id, dispatch_id, host, created_at)
        VALUES ('old-row', 'bot-1', 'slack', '${THREAD.externalId}', 1, 'task-1', 'dispatch-1', 'local', 1);
    `)
    old.close()

    const store = BotWorkStore.open(path)
    const row = store.live('bot-1', THREAD)
    expect(row).toMatchObject({ rowId: 'old-row', current: true })
    expect(store.bind(bind({ dispatchId: 'dispatch-2' }))).toBeNull()
    // The old index is gone: a replaced row stays live beside the new current one.
    expect(row && store.replace(row, bind({ dispatchId: 'dispatch-2' }))).toMatchObject({
      generation: 2,
      current: true
    })
    expect(store.addressRows('bot-1', THREAD)).toHaveLength(2)
  })

  it('keeps addresses of different bots and places apart', () => {
    const store = BotWorkStore.open(':memory:')
    expect(store.bind(bind())).not.toBeNull()
    expect(store.bind(bind({ botId: 'bot-2' }))).not.toBeNull()
    expect(store.bind(bind({ address: { source: 'linear', externalId: 'ENG-1' } }))).not.toBeNull()
    expect(store.liveRows()).toHaveLength(3)
    expect(store.liveRows('bot-2')).toHaveLength(1)
  })
})
