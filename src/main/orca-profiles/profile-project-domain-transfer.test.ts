import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { runProcess } from '../../shared/child-process/run-process'
import { getDefaultPersistedState } from '../../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../shared/orca-profiles'
import type { Repo } from '../../shared/repo-types'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot
} from '../persistence/profile-state/profile-state-documents'
import { writeProfileStateDomain } from '../persistence/profile-state/profile-state-domain-writes'
import {
  prepareProfileProjectDomainChanges,
  profileProjectDomainFingerprint,
  validateProfileProjectDomainChanges
} from './profile-project-domain-changes'
import * as domainState from './profile-project-domain-state'
import { createProfileProjectDomainMoveIntent } from './profile-project-domain-move-intent'
import {
  persistProfileProjectMoveIntent,
  recoverPendingProfileProjectMoves
} from './profile-project-move-intent'
import { normalizeProfileProjectState } from './profile-project-state-file'
import { removeSourceRepo } from './profile-project-source-removal'
import {
  applyPayloadToTarget,
  createTargetRepo,
  createTransferPayload
} from './profile-project-transfer-payload'
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

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      frozen(nested)
    }
    Object.freeze(value)
  }
  return value
}

function preparedMove() {
  const source = domainState.readProfileProjectTransferState('source', root)
  const target = domainState.readProfileProjectTransferState('target', root)
  if (
    source.revision === undefined ||
    target.revision === undefined ||
    !source.documents ||
    !target.documents
  ) {
    throw new Error('Missing SQL fixture')
  }
  const sourceRepo = source.state.repos[0]
  if (!sourceRepo) {
    throw new Error('Missing source repo')
  }
  const targetRepo = createTargetRepo(sourceRepo, target.state, false)
  const payload = createTransferPayload({
    sourceState: source.state,
    sourceRepo,
    targetRepo,
    includeSessions: true
  })
  const sourceAfter = removeSourceRepo(source.state, sourceRepo.id)
  const targetAfter = applyPayloadToTarget(target.state, payload)
  const intent = createProfileProjectDomainMoveIntent({
    sourceProfileId: 'source',
    targetProfileId: 'target',
    source: prepareProfileProjectDomainChanges(source.revision, source.documents, sourceAfter),
    target: prepareProfileProjectDomainChanges(target.revision, target.documents, targetAfter)
  })
  return { intent, sourceAfter, targetAfter }
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
  it.each(['copy', 'move'] as const)(
    '%s preserves the full normalized projection and unchanged physical rows',
    (mode) => {
      const beforeSource = domainState.readProfileProjectTransferState('source', root).state
      const beforeTarget = domainState.readProfileProjectTransferState('target', root).state
      const physicalBefore = withDatabase('target', (db) =>
        db
          .prepare(
            "SELECT * FROM profile_state_documents WHERE domain IN ('futureOpaque', '', '__proto__', 'futureNull') ORDER BY domain"
          )
          .all()
      )
      const result = transfer(mode)
      expect(result.status).toBe('transferred')
      const afterTarget = JSON.parse(raw('target').json)
      const targetRepo: Repo = afterTarget.repos[0]
      const payload = createTransferPayload({
        sourceState: beforeSource,
        sourceRepo: repo,
        targetRepo,
        includeSessions: mode === 'move'
      })
      expect(afterTarget).toEqual(
        JSON.parse(JSON.stringify(applyPayloadToTarget(beforeTarget, payload)))
      )
      expect(afterTarget.settings.opencodeSessionCookie).toBe('enc:v1:sealed-inactive')
      expect(
        withDatabase('target', (db) =>
          db
            .prepare(
              "SELECT * FROM profile_state_documents WHERE domain IN ('futureOpaque', '', '__proto__', 'futureNull') ORDER BY domain"
            )
            .all()
        )
      ).toEqual(physicalBefore)
      expect(raw('target').revision).toBe(2)
      expect(raw('source').revision).toBe(mode === 'move' ? 2 : 1)
      if (mode === 'move') {
        expect(JSON.parse(raw('source').json)).toEqual(
          JSON.parse(JSON.stringify(removeSourceRepo(beforeSource, repo.id)))
        )
      }
    }
  )

  it.each(['git', 'folder', 'ssh'] as const)(
    'normalization and %s projections do not mutate raw nested values',
    (kind) => {
      const snapshot = domainState.readProfileProjectTransferState('source', root)
      const input = Object.fromEntries(
        (snapshot.documents ?? []).map(({ domain, value }) => [domain, value])
      )
      input.repos = [
        {
          ...repo,
          kind: kind === 'folder' ? 'folder' : 'git',
          connectionId: kind === 'ssh' ? 'remote' : null
        }
      ]
      input.projects = [
        {
          id: 'old-project',
          displayName: 'Previous',
          badgeColor: 'neutral',
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ]
      input.workspaceSession = {
        ...getDefaultPersistedState('/test').workspaceSession,
        tabsByWorktree: {
          'repo-1::/project/branch': [
            {
              id: 'tab',
              ptyId: 'pty',
              worktreeId: 'repo-1::/project/branch',
              title: 'Shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }
      if (kind === 'ssh') {
        input.workspaceSessionsByHostId = { 'runtime:remote': input.workspaceSession }
      }
      const before = JSON.stringify(input)
      frozen(input)
      const source = frozen(normalizeProfileProjectState(input))
      const target = frozen(normalizeProfileProjectState({ repos: [] }))
      const sourceRepo = source.repos[0]
      if (!sourceRepo) {
        throw new Error('Missing source repo')
      }
      const payload = frozen(
        createTransferPayload({
          sourceState: source,
          sourceRepo,
          targetRepo: createTargetRepo(sourceRepo, target, false),
          includeSessions: true
        })
      )
      expect(() => applyPayloadToTarget(target, payload)).not.toThrow()
      expect(() => removeSourceRepo(source, sourceRepo.id)).not.toThrow()
      expect(JSON.stringify(input)).toBe(before)
      expect(Object.entries(source).find(([domain]) => domain === 'futureOpaque')?.[1]).toBe(
        input.futureOpaque
      )
    }
  )

  it('journals only changed domains and replays target-first with exact revisions', () => {
    const { intent, sourceAfter, targetAfter } = preparedMove()
    expect(intent.source.replacements.map(({ domain }) => domain)).not.toContain('futureOpaque')
    expect(JSON.stringify(intent).length).toBeLessThan(40_000)
    persistProfileProjectMoveIntent(root, intent)
    domainState.writeProfileProjectDomainChanges('target', root, intent.target)
    expect(recoverPendingProfileProjectMoves(root)).toBe(1)
    expect(JSON.parse(raw('source').json)).toEqual(JSON.parse(JSON.stringify(sourceAfter)))
    expect(JSON.parse(raw('target').json)).toEqual(JSON.parse(JSON.stringify(targetAfter)))
    expect(raw('source').revision).toBe(2)
    expect(raw('target').revision).toBe(2)
    expect(recoverPendingProfileProjectMoves(root)).toBe(0)
  })

  it.each(['source', 'target'] as const)(
    'refuses an unrelated %s write and retains the move intent',
    (participant) => {
      const { intent } = preparedMove()
      persistProfileProjectMoveIntent(root, intent)
      domainState.writeProfileProjectDomainChanges('target', root, intent.target)
      withDatabase(participant, (db) =>
        writeProfileStateDomain(db, {
          expectedRevision: participant === 'source' ? 1 : 2,
          domain: 'unrelated',
          payload: 'true'
        })
      )
      expect(() => recoverPendingProfileProjectMoves(root)).toThrow(/conflicts|unrecognized/)
      expect(readdirSync(join(root, 'profile-move-intents'))).toContain(`${intent.id}.json`)
      expect(JSON.parse(raw('source').json).repos).toHaveLength(1)
    }
  )

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

  it('distinguishes deletions and null while ignoring extra executable mutation options', () => {
    const snapshot = domainState.readProfileProjectTransferState('target', root)
    if (!snapshot.documents || snapshot.revision === undefined) {
      throw new Error('Missing SQL fixture')
    }
    const after = { ...snapshot.state, futureDelete: undefined, futureNull: null, addedNull: null }
    const changes = prepareProfileProjectDomainChanges(snapshot.revision, snapshot.documents, after)
    const poisoned = {
      ...changes,
      automationRunsAfter: [{}],
      replacements: changes.replacements.map((replacement) => ({
        ...replacement,
        domainVersion: -1
      }))
    }
    domainState.writeProfileProjectDomainChanges('target', root, poisoned)
    const saved = JSON.parse(raw('target').json)
    expect(saved.futureNull).toBeNull()
    expect(saved.addedNull).toBeNull()
    expect(saved).not.toHaveProperty('futureDelete')
    expect(saved.automationRuns).toEqual([])
  })

  it.each(['payload', 'afterHash', 'duplicate', 'revision', 'before'] as const)(
    'rejects %s tampering before recovery modifies either participant',
    (kind) => {
      const { intent } = preparedMove()
      persistProfileProjectMoveIntent(root, intent)
      domainState.writeProfileProjectDomainChanges('target', root, intent.target)
      const before = raw('source').json
      if (kind === 'payload') {
        intent.source.replacements[0]!.payload = 'null'
      }
      if (kind === 'afterHash') {
        intent.source.afterHash = 'a'.repeat(64)
      }
      if (kind === 'duplicate') {
        intent.source.replacements.push(intent.source.replacements[0]!)
      }
      if (kind === 'revision') {
        intent.source.expectedRevision = Number.MAX_SAFE_INTEGER
      }
      if (kind === 'before') {
        intent.source.before.push(intent.source.before[0]!)
      }
      writeFileSync(join(root, 'profile-move-intents', `${intent.id}.json`), JSON.stringify(intent))
      expect(() => recoverPendingProfileProjectMoves(root)).toThrow()
      expect(raw('source').json).toBe(before)
      expect(readFileSync(join(root, 'profile-move-intents', `${intent.id}.json`), 'utf8')).toBe(
        JSON.stringify(intent)
      )
    }
  )

  it('canonicalizes only domain ordering in fingerprints', () => {
    const a = { domain: 'a', hash: hashProfileStateJson('{"x":1,"y":2}') }
    const b = { domain: 'b', hash: hashProfileStateJson('[2,1]') }
    expect(profileProjectDomainFingerprint([a, b])).toBe(profileProjectDomainFingerprint([b, a]))
    expect(profileProjectDomainFingerprint([a, b])).not.toBe(
      profileProjectDomainFingerprint([{ ...a, hash: hashProfileStateJson('{"y":2,"x":1}') }, b])
    )
    const { intent } = preparedMove()
    expect(() => validateProfileProjectDomainChanges(intent.source)).not.toThrow()
  })

  const crashStages = [
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
  it.each(crashStages)('recovers exact state after actual SIGKILL at %s', async (stage) => {
    const sourceBefore = raw('source').json
    const targetBefore = raw('target').json
    const { sourceAfter, targetAfter } = preparedMove()
    const child = await runProcess({
      program: process.execPath,
      args: [crashScript, crashBundle, root, stage],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        NODE_PATH: join(process.cwd(), 'node_modules')
      },
      timeoutMs: 10_000,
      maxOutputBytes: 16_384
    })
    expect(child.timedOut, child.stderr).toBe(false)
    expect(child.stdout, child.stderr).toBe(`${stage}\n`)
    expect(child.code).not.toBe(0)
    if (process.platform !== 'win32') {
      expect(child.signal).toBe('SIGKILL')
    }
    recoverPendingProfileProjectMoves(root)
    const targetCommitted = ![
      'intent-before-publish',
      'intent-published',
      'intent-durable',
      'target-before-commit'
    ].includes(stage)
    expect(JSON.parse(raw('source').json)).toEqual(
      targetCommitted ? JSON.parse(JSON.stringify(sourceAfter)) : JSON.parse(sourceBefore)
    )
    expect(JSON.parse(raw('target').json)).toEqual(
      targetCommitted ? JSON.parse(JSON.stringify(targetAfter)) : JSON.parse(targetBefore)
    )
    expect(raw('source').revision).toBe(targetCommitted ? 2 : 1)
    expect(raw('target').revision).toBe(targetCommitted ? 2 : 1)
    expect(recoverPendingProfileProjectMoves(root)).toBe(0)
  })
})
