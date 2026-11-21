import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { HERMES_LAUNCH_SPEC } from './hermes-acp-launch-spec'

describe('HERMES_LAUNCH_SPEC modelDiscovery', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses on-demand session discovery in a private folder', () => {
    expect(HERMES_LAUNCH_SPEC.modelDiscovery).toMatchObject({
      kind: 'session',
      listingNamesConfiguredModel: false,
      inPrivateFolder: true,
      listsOnDemand: true
    })
  })

  it('discardSession deletes only the temporary ACP listing row from state.db', async () => {
    const discovery = HERMES_LAUNCH_SPEC.modelDiscovery
    if (discovery.kind !== 'session' || !discovery.discardSession) {
      throw new Error('Expected session modelDiscovery with discardSession')
    }

    const home = mkdtempSync(join(tmpdir(), 'hermes-discard-'))
    dirs.push(home)
    const dbPath = join(home, 'state.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);
      INSERT INTO sessions VALUES ('listing-1', 'acp', 1), ('chat-1', 'cli', 2);
    `)
    db.close()

    await discovery.discardSession({ sessionId: 'listing-1', cwd: '/tmp', accountHomePath: home })

    const check = new DatabaseSync(dbPath)
    const rows = check.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>
    check.close()
    expect(rows).toEqual([{ id: 'chat-1' }])
  })

  it('discardSession is a no-op when state.db is absent', async () => {
    const discovery = HERMES_LAUNCH_SPEC.modelDiscovery
    if (discovery.kind !== 'session' || !discovery.discardSession) {
      throw new Error('Expected session modelDiscovery with discardSession')
    }
    const home = mkdtempSync(join(tmpdir(), 'hermes-missing-'))
    dirs.push(home)

    await expect(
      discovery.discardSession({ sessionId: 'missing', cwd: '/tmp', accountHomePath: home })
    ).resolves.toBeUndefined()
  })
})
