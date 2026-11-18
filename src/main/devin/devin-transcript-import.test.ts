import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { devinTranscriptImport } from './devin-transcript-import'

const HOME = { variable: 'XDG_DATA_HOME', path: '/data/home' }

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

function writeSessionsDb(dbPath: string, ids: readonly string[]): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT)')
    const insert = db.prepare('INSERT INTO sessions (id) VALUES (?)')
    for (const id of ids) {
      insert.run(id)
    }
  } finally {
    db.close()
  }
}

describe('devinTranscriptImport', () => {
  it('stores conversations under the account data home', () => {
    const importer = devinTranscriptImport({ managedAccounts: () => unmanaged() })
    expect(importer.conversationStore({ accountHome: HOME, launchEnv: {} })).toBe(
      join('/data/home', 'devin', 'cli')
    )
  })

  it('admits a session its database records and refuses one it does not', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-devin-import-'))
    const store = join(root, 'devin', 'cli')
    await mkdir(store, { recursive: true })
    const dbPath = join(store, 'sessions.db')
    writeSessionsDb(dbPath, ['lucky-ring'])
    const importer = devinTranscriptImport({ managedAccounts: () => unmanaged() })

    const find = (providerSessionId: string) =>
      importer.findTranscript({ providerSessionId, store, launchEnv: {}, workspaceCwd: '' })
    expect(await find('lucky-ring')).toBe(dbPath)
    expect(await find('absent')).toBeNull()
  })

  it('offers managed account homes ahead of the default home', () => {
    const importer = devinTranscriptImport({
      managedAccounts: () => ({
        transcriptEnvironments: () => [{ XDG_DATA_HOME: '/managed/one' }]
      }),
      platform: 'darwin',
      homePath: '/person'
    })
    expect(importer.accountHomeCandidates({ settings: {}, selectedAccountHome: HOME })).toEqual([
      HOME,
      { variable: 'XDG_DATA_HOME', path: '/managed/one' },
      { variable: 'XDG_DATA_HOME', path: join('/person', '.local', 'share') }
    ])
  })
})

function unmanaged() {
  const transcriptEnvironments = (): Record<string, string>[] => []
  return { transcriptEnvironments }
}
