import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('bounded task inventory', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('returns a bounded inventory page without task content', () => {
    const d = createDb()
    const first = d.createTask({ spec: 'secret task specification' })
    const second = d.createTask({ spec: 'another secret specification' })
    d.updateTaskStatus(second.id, 'completed', '{"secret":"result"}')

    const page = d.listBoundedTaskInventory({ limit: 1 })

    expect(page).toMatchObject({
      tasks: [{ id: first.id, title: `Task ${first.id}`, status: 'ready' }],
      totalCount: 2,
      truncated: true
    })
    expect(typeof page.nextCursor).toBe('string')
    expect(JSON.stringify(page)).not.toContain('secret task specification')
    expect(JSON.stringify(page)).not.toContain('another secret specification')
    expect(JSON.stringify(page)).not.toContain('"result"')
    expect(Object.keys(page.tasks[0] ?? {})).toEqual(['id', 'title', 'status'])
  })

  it('continues one bounded inventory snapshot without including concurrent tasks', () => {
    const d = createDb()
    const first = d.createTask({ spec: 'first secret' })
    const second = d.createTask({ spec: 'second secret' })
    const third = d.createTask({ spec: 'third secret' })

    const firstPage = d.listBoundedTaskInventory({ limit: 2 })
    const concurrent = d.createTask({ spec: 'concurrent secret' })
    const secondPage = d.listBoundedTaskInventory({
      limit: 2,
      cursor: firstPage.nextCursor ?? ''
    })

    expect([...firstPage.tasks, ...secondPage.tasks].map((task) => task.id)).toEqual([
      first.id,
      second.id,
      third.id
    ])
    expect(secondPage.totalCount).toBe(3)
    expect(secondPage.truncated).toBe(false)
    expect(JSON.stringify(secondPage)).not.toContain(concurrent.id)
  })

  it('fails closed when a bounded inventory cursor no longer matches its snapshot', () => {
    const d = createDb()
    d.createTask({ spec: 'first secret' })
    d.createTask({ spec: 'second secret' })

    const firstPage = d.listBoundedTaskInventory({ limit: 1 })
    d.resetTasks()

    expect(() =>
      d.listBoundedTaskInventory({ limit: 1, cursor: firstPage.nextCursor ?? '' })
    ).toThrow('Invalid bounded task inventory cursor')
  })

  it('rejects malformed bounded inventory cursors', () => {
    const d = createDb()
    d.createTask({ spec: 'secret' })

    expect(() => d.listBoundedTaskInventory({ limit: 1, cursor: 'not-a-cursor!' })).toThrow(
      'Invalid bounded task inventory cursor'
    )
  })

  it('rejects a valid-shaped cursor altered after issuance', () => {
    const d = createDb()
    d.createTask({ spec: 'first secret' })
    d.createTask({ spec: 'second secret' })

    const firstPage = d.listBoundedTaskInventory({ limit: 1 })
    const payload = JSON.parse(
      Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString('utf8')
    ) as { lastRowId: number }
    payload.lastRowId = 0
    const alteredCursor = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

    expect(() => d.listBoundedTaskInventory({ limit: 1, cursor: alteredCursor })).toThrow(
      'Invalid bounded task inventory cursor'
    )
  })

  it('rejects a cursor with duplicate JSON members', () => {
    const d = createDb()
    d.createTask({ spec: 'first secret' })
    d.createTask({ spec: 'second secret' })

    const firstPage = d.listBoundedTaskInventory({ limit: 1 })
    const decoded = Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString('utf8')
    const duplicateMember = decoded.replace(/"lastRowId":\d+/, (member) => `${member},${member}`)
    const malformedCursor = Buffer.from(duplicateMember, 'utf8').toString('base64url')

    expect(() => d.listBoundedTaskInventory({ limit: 1, cursor: malformedCursor })).toThrow(
      'Invalid bounded task inventory cursor'
    )
  })

  it('invalidates an outstanding cursor after a runtime restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-bounded-inventory-'))
    const dbPath = join(root, 'orchestration.db')
    const initial = new OrchestrationDb(dbPath)
    initial.createTask({ spec: 'first secret' })
    initial.createTask({ spec: 'second secret' })
    const firstPage = initial.listBoundedTaskInventory({ limit: 1 })
    initial.close()

    const restarted = new OrchestrationDb(dbPath)
    try {
      expect(() =>
        restarted.listBoundedTaskInventory({ limit: 1, cursor: firstPage.nextCursor ?? '' })
      ).toThrow('Invalid bounded task inventory cursor')
    } finally {
      restarted.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('works inside a caller-owned transaction', () => {
    const d = createDb()
    d.createTask({ spec: 'first secret' })
    d.createTask({ spec: 'second secret' })
    const connection = d as unknown as { db: { exec(sql: string): void } }

    connection.db.exec('BEGIN')
    try {
      expect(d.listBoundedTaskInventory({ limit: 1 })).toMatchObject({
        totalCount: 2,
        truncated: true
      })
    } finally {
      connection.db.exec('ROLLBACK')
    }
  })
})
