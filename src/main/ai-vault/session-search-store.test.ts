import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import { AiVaultSessionFtsStore } from './session-search-store'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createStore(): AiVaultSessionFtsStore {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ai-vault-fts-'))
  tempDirs.push(dir)
  return new AiVaultSessionFtsStore(join(dir, 'index.sqlite'))
}

describe('AiVaultSessionFtsStore', () => {
  it('indexes searchable text and updates incrementally', () => {
    const store = createStore()
    const first = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Fix Linux pairing'
    })
    const extra = createAiVaultTestSession({
      id: 'codex:2',
      agent: 'codex',
      title: 'Onboarding wizard'
    })

    expect(store.sync([first, extra])).toEqual({ upserted: 2, deleted: 0 })
    expect(store.sync([first, extra])).toEqual({ upserted: 0, deleted: 0 })
    expect(store.query(['pairing', 'linux'])).toEqual(['claude:1'])

    const renamed = {
      ...first,
      title: 'Repair Windows pairing',
      modifiedAt: '2026-05-02T00:00:00.000Z'
    }
    expect(store.sync([renamed])).toEqual({ upserted: 1, deleted: 1 })
    expect(store.query(['windows'])).toEqual(['claude:1'])
    expect(store.query(['wizard'])).toEqual([])
    store.close()
  })

  it('rolls back a mid-write upsert so the previous revision stays searchable', () => {
    const store = createStore()
    const first = createAiVaultTestSession({
      id: 'claude:1',
      title: 'Fix Linux pairing'
    })
    expect(store.sync([first])).toEqual({ upserted: 1, deleted: 0 })

    const db = (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    const originalPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql)
      if (sql.includes('INSERT OR IGNORE INTO session_tokens')) {
        return {
          run: () => {
            throw new Error('token write failed')
          }
        }
      }
      return statement
    }) as typeof db.prepare

    expect(() =>
      store.sync([
        {
          ...first,
          title: 'Repair Windows pairing',
          modifiedAt: '2026-05-02T00:00:00.000Z'
        }
      ])
    ).toThrow('token write failed')

    db.prepare = originalPrepare
    expect(store.query(['linux'])).toEqual(['claude:1'])
    expect(store.query(['windows'])).toEqual([])
    store.close()
  })
})
