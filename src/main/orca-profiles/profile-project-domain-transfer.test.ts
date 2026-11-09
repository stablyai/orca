import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../shared/orca-profiles'
import type { Repo } from '../../shared/repo-types'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot
} from '../persistence/profile-state/profile-state-documents'
import { transferOrcaProfileProject } from './profile-project-transfer'

let root: string
let crashRoot: string
let crashBundle: string
let crashScript: string
const repo: Repo = {
  id: 'repo-1',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'neutral',
  addedAt: 1,
  kind: 'git',
  connectionId: null
}

function dbPath(id: string): string {
  return join(root, 'profiles', id, 'profile-state.db')
}

function withDatabase<T>(
  id: string,
  action: (db: ReturnType<typeof openProfileStateDatabase>['db']) => T
): T {
  const opened = openProfileStateDatabase(dbPath(id), id)
  try {
    return action(opened.db)
  } finally {
    opened.db.close()
  }
}

function seed(id: string, repos: Repo[] = []): void {
  mkdirSync(join(root, 'profiles', id), { recursive: true })
  withDatabase(id, (db) =>
    importProfileStateJson(
      db,
      JSON.stringify({
        futureOpaque: { z: ['\ud800', null, id], a: 'x'.repeat(100_000) },
        ['']: { keep: true },
        ['__proto__']: { inert: true },
        settings: { opencodeSessionCookie: 'enc:v1:sealed-inactive', unknownSetting: [2, 1] },
        repos,
        projects: null,
        projectHostSetups: null,
        workspaceSessionsByHostId: null,
        automationRuns: [],
        futureNull: null,
        futureDelete: { remove: true }
      })
    )
  )
}

function raw(id: string) {
  return withDatabase(id, (db) => readProfileStateSnapshot(db))
}

function transfer(mode: 'copy' | 'move' = 'move') {
  return transferOrcaProfileProject(
    { sourceProfileId: 'source', targetProfileId: 'target', repoId: repo.id, mode },
    root
  )
}

beforeAll(() => {
  crashRoot = mkdtempSync(join(tmpdir(), 'orca-domain-move-crash-api-'))
  crashBundle = join(crashRoot, 'api.cjs')
  crashScript = join(crashRoot, 'crash.cjs')
  buildSync({
    stdin: {
      contents:
        "export { transferOrcaProfileProject } from './src/main/orca-profiles/profile-project-transfer'",
      loader: 'ts',
      resolveDir: process.cwd()
    },
    outfile: crashBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  writeFileSync(
    crashScript,
    `
const fs = require('node:fs')
const path = require('node:path')
const [bundle, root, stage] = process.argv.slice(2)
const barrier = label => {
  if (label !== stage) return
  fs.writeSync(1, label + '\\n')
  process.kill(process.pid, 'SIGKILL')
  throw new Error('SIGKILL returned')
}
const sqlite = require('node:sqlite')
const exec = sqlite.DatabaseSync.prototype.exec
const writers = new WeakSet()
sqlite.DatabaseSync.prototype.exec = function(sql) {
  const writing = writers.has(this)
  const participant = writing ? this.prepare("SELECT value FROM profile_state_meta WHERE key = 'profile_id'").get().value : ''
  if (writing && sql === 'COMMIT') barrier(participant + '-before-commit')
  const result = exec.call(this, sql)
  if (sql === 'BEGIN IMMEDIATE') writers.add(this)
  if (sql === 'COMMIT' || sql === 'ROLLBACK') writers.delete(this)
  if (writing && sql === 'COMMIT') barrier(participant + '-committed')
  return result
}
let published = false
let removed = false
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  const intent = path.dirname(to) === path.join(root, 'profile-move-intents') && to.endsWith('.json')
  if (intent) barrier('intent-before-publish')
  rename(from, to)
  if (intent) { published = true; barrier('intent-published') }
}
const rm = fs.rmSync
fs.rmSync = (target, ...rest) => {
  const intent = path.dirname(target) === path.join(root, 'profile-move-intents') && target.endsWith('.json')
  if (intent) barrier('cleanup-before-remove')
  rm(target, ...rest)
  if (intent) { removed = true; barrier('cleanup-removed') }
}
const fsync = fs.fsyncSync
fs.fsyncSync = fd => {
  fsync(fd)
  if (fs.fstatSync(fd).isDirectory()) {
    if (removed) barrier('cleanup-durable')
    else if (published) barrier('intent-durable')
  }
}
require(bundle).transferOrcaProfileProject({ sourceProfileId: 'source', targetProfileId: 'target', repoId: 'repo-1', mode: 'move' }, root)
throw new Error('Crash boundary not reached: ' + stage)
`
  )
})

afterAll(() => rmSync(crashRoot, { recursive: true, force: true }))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-domain-transfer-'))
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'source',
      profiles: ['source', 'target'].map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: id[0], color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
  seed('source', [repo])
  seed('target')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('profile domain transfers', () => {
  it('refuses independently hashed malformed unrelated data before a copy writes anything', () => {
    const before = raw('target').json
    withDatabase('source', (db) =>
      db
        .prepare(
          'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
        )
        .run('null,"extra":true', hashProfileStateJson('null,"extra":true'), 'futureNull')
    )
    expect(() => transfer('copy')).toThrow(/JSON/)
    expect(raw('target').json).toBe(before)
  })
  void [
    'intent-before-publish',
    'intent-published',
    ...(process.platform === 'win32' ? [] : ['intent-durable']),
    'target-before-commit',
    'target-committed',
    'source-before-commit',
    'source-committed',
    'cleanup-before-remove',
    'cleanup-removed',
    ...(process.platform === 'win32' ? [] : ['cleanup-durable'])
  ]
})
