import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Os from 'node:os'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { hermesDiscoveries } from './session-scanner-hermes-sources'

const paths = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-hermes-homes-'))
  return { root, home: path.join(root, 'User') }
})
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => paths.home
}))

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (realPlatform) {
    Object.defineProperty(process, 'platform', realPlatform)
  }
  vi.unstubAllEnvs()
})
afterAll(async () => {
  await rm(paths.root, { recursive: true, force: true })
})

async function discoverHome(home: string): Promise<string[]> {
  const sessions = join(home, 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(
    join(sessions, 'session_legacy.json'),
    '{"session_id":"legacy","messages":[{"role":"user","content":"hello"}]}'
  )
  const db = new SyncDatabase(join(home, 'state.db'))
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      INSERT INTO sessions VALUES ('sqlite-session', 1800000000);
      INSERT INTO messages VALUES ('sqlite-session', 'user', 'hello', 1800000000);
    `)
  } finally {
    db.close()
  }
  const discoveries = await Promise.all(hermesDiscoveries({}, [], 10, []))
  return discoveries.flatMap((result) => result.files).map((file) => file.path)
}

it('discovers SQLite and legacy sessions under the Windows default Hermes home', async () => {
  const localAppData = join(paths.root, 'Local')
  const home = join(localAppData, 'hermes')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.stubEnv('LOCALAPPDATA', localAppData)
  vi.stubEnv('HERMES_HOME', '')

  const files = await discoverHome(home)

  expect(files).toEqual([
    join(home, 'sessions', 'session_legacy.json'),
    `${join(home, 'state.db')}#sqlite-session`
  ])
})

it('discovers SQLite and legacy sessions under HERMES_HOME', async () => {
  const home = join(paths.root, 'custom-hermes')
  vi.stubEnv('HERMES_HOME', home)

  const files = await discoverHome(home)

  expect(files).toEqual([
    join(home, 'sessions', 'session_legacy.json'),
    `${join(home, 'state.db')}#sqlite-session`
  ])
})
