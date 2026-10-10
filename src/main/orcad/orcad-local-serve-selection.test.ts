import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import { formatOrcadNativePreflightReport } from '../../shared/orcad-native-preflight-report'
import { SERVE_RUNTIME_ENV } from '../../shared/orcad-local-serve-selection'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import { PROFILE_STATE_DATABASE_FILE_NAME } from '../../shared/profile-state-storage-paths'
import Database from '../sqlite/sync-database'
import {
  openProfileStateDatabase,
  profileStatePragmaNumber
} from '../persistence/profile-state/profile-state-database'
import { hashProfileStatePayload } from '../persistence/profile-state/profile-state-document-validation'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { selectServeRuntime, type ServeRuntimeSelectionInput } from './orcad-local-serve-selection'

const TARGET = 'linux-x64-glibc'
const SSH_TARGET = { id: 'ssh-1', label: 'box', host: 'box.example', port: 22, username: 'me' }
const SHA = NODE_RUNTIME_ASSETS[TARGET].executableSha256
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-serve-runtime-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A materialized slot as the template would leave it: no runtime of its own yet. */
function slotFixture(): string {
  const slot = join(root, 'orcad-artifacts', TARGET, '0.1.0+abc')
  mkdirSync(slot, { recursive: true })
  writeFileSync(join(slot, ORCAD_SERVER_TARGET_FILENAME), `${TARGET}\n`)
  writeFileSync(join(slot, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${SHA}\n`)
  writeFileSync(join(slot, ORCAD_VERSION_FILENAME), '0.1.0+abc\n')
  writeFileSync(join(slot, 'orcad.js'), '')
  writeFileSync(join(slot, 'orcad-server.js'), '')
  return slot
}

/** A valid schema-1 profile, as an Orca from before the normalized run tables left it. */
function seedSchemaV1Profile(dbPath: string, state: Record<string, unknown>): void {
  const db = new Database(dbPath)
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE profile_state_documents (
      domain TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      domain_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run(
    'profile_id',
    DEFAULT_LOCAL_ORCA_PROFILE_ID
  )
  db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run('revision', '1')
  const insert = db.prepare(
    `INSERT INTO profile_state_documents
      (domain, payload, domain_version, revision, updated_at, content_hash)
     VALUES (?, ?, 1, 1, 100, ?)`
  )
  for (const [domain, value] of Object.entries(state)) {
    const payload = JSON.stringify(value)
    insert.run(domain, payload, hashProfileStatePayload(payload))
  }
  db.close()
}

function schemaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    return profileStatePragmaNumber(db, 'user_version')
  } finally {
    db.close()
  }
}

function input(overrides: Partial<ServeRuntimeSelectionInput> = {}): ServeRuntimeSelectionInput {
  const template = join(root, 'orcad-template')
  mkdirSync(template, { recursive: true })
  const cachedNode = join(root, 'cached-node')
  writeFileSync(cachedNode, '#!/bin/sh\n')
  return {
    env: {},
    platform: 'linux',
    userDataPath: root,
    templateDirs: [join(root, 'missing-template'), template],
    hostTarget: () => TARGET,
    materializeSlot: vi.fn(async () => slotFixture()),
    materializeRuntime: vi.fn(async () => cachedNode),
    nativePreflight: async () => `${formatOrcadNativePreflightReport('ok', null)}\n`,
    ...overrides
  }
}

describe('orca serve runtime selection', () => {
  it('stays on Electron, silently, when Electron is asked for', async () => {
    const options = input({ env: { [SERVE_RUNTIME_ENV]: 'electron' } })
    expect(await selectServeRuntime(options)).toEqual({ kind: 'electron', reason: null })
    expect(options.materializeSlot).not.toHaveBeenCalled()
  })

  it('serves on orcad by default and when orcad is asked for by name, Windows included', async () => {
    for (const env of [{}, { [SERVE_RUNTIME_ENV]: 'orcad' }]) {
      for (const platform of ['linux', 'win32'] as const) {
        expect(await selectServeRuntime(input({ env, platform }))).toMatchObject({ kind: 'orcad' })
      }
    }
  })

  it('stays on Electron by default when the profile has SSH targets orcad cannot serve (#25886)', async () => {
    const options = input({ profileHasSshTargets: () => true })
    expect(await selectServeRuntime(options)).toEqual({
      kind: 'electron',
      reason: 'this profile has SSH targets, which orcad cannot serve yet'
    })
    expect(options.materializeSlot).not.toHaveBeenCalled()
  })

  it('keeps orcad for SSH profiles when orcad is asked for by name', async () => {
    const named = input({ env: { [SERVE_RUNTIME_ENV]: 'orcad' }, profileHasSshTargets: () => true })
    expect(await selectServeRuntime(named)).toMatchObject({ kind: 'orcad' })
  })

  it('stays on Electron when it cannot tell whether the profile has SSH targets', async () => {
    const unreadable = input({
      profileHasSshTargets: () => {
        throw new Error('locked')
      }
    })
    expect(await selectServeRuntime(unreadable)).toEqual({
      kind: 'electron',
      reason:
        'could not tell whether this profile has SSH targets, which orcad cannot serve yet (locked)'
    })
    expect(unreadable.materializeSlot).not.toHaveBeenCalled()
  })

  it.each([
    ['with', [SSH_TARGET], 'electron'],
    ['without', [], 'orcad']
  ] as const)(
    'stays on Electron, without migrating, for a schema-1 profile %s SSH targets',
    async (_label, targets, afterMigration) => {
      const dbPath = join(root, PROFILE_STATE_DATABASE_FILE_NAME)
      seedSchemaV1Profile(dbPath, { sshTargets: targets })
      expect(await selectServeRuntime(input())).toMatchObject({
        kind: 'electron',
        reason: expect.stringContaining('could not tell whether this profile has SSH targets')
      })
      expect(schemaVersion(dbPath)).toBe(1)
      // The serve host's own open migrates it; selection then reads the same targets.
      openProfileStateDatabase(dbPath, DEFAULT_LOCAL_ORCA_PROFILE_ID).db.close()
      expect(await selectServeRuntime(input())).toMatchObject({ kind: afterMigration })
    }
  )

  it('serves on orcad for a current-schema profile with no SSH targets', async () => {
    const opened = openProfileStateDatabase(
      join(root, PROFILE_STATE_DATABASE_FILE_NAME),
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    importProfileStateJson(opened.db, JSON.stringify({ sshTargets: [], settings: {} }))
    opened.db.close()
    expect(await selectServeRuntime(input())).toMatchObject({ kind: 'orcad' })
  })

  it('reads SSH targets from the profile on disk', async () => {
    writeFileSync(join(root, 'orca-data.json'), JSON.stringify({ sshTargets: [{ id: 'ssh-1' }] }))
    expect(await selectServeRuntime(input())).toMatchObject({ kind: 'electron' })
  })

  it('runs the local slot on its pinned Node, linked into userData beside it', async () => {
    const options = input()
    const selection = await selectServeRuntime(options)
    const slot = join(root, 'orcad-artifacts', TARGET, '0.1.0+abc')
    const runtime = join(slot, ...orcadNodeRuntimeRelativePath(TARGET, SHA))
    expect(selection).toEqual({
      kind: 'orcad',
      runtime,
      entry: join(slot, 'orcad-server.js'),
      version: '0.1.0+abc'
    })
    expect(existsSync(runtime)).toBe(true)
    expect(runtime.startsWith(join(root, 'orcad-artifacts'))).toBe(true)
    expect(options.materializeSlot).toHaveBeenCalledWith(TARGET, {
      templateDir: join(root, 'orcad-template'),
      cacheRoot: join(root, 'orcad-artifacts')
    })
  })

  it.each([
    [
      'an unknown runtime name',
      { env: { [SERVE_RUNTIME_ENV]: 'bun' } },
      'ORCA_SERVE_RUNTIME=bun is neither orcad nor electron'
    ],
    ['an unsupported host', { hostTarget: () => 'linux-riscv64-glibc' }, 'no orcad build exists'],
    ['an install without the template', { templateDirs: [] }, 'carries no orcad template'],
    [
      'an offline first run',
      {
        materializeRuntime: vi.fn(async (): Promise<string> => {
          throw new Error('fetch failed')
        })
      },
      'could not be prepared: fetch failed'
    ],
    [
      'a host whose node-pty cannot load',
      {
        nativePreflight: async () => formatOrcadNativePreflightReport('blocked', 'load_crashed')
      },
      'cannot run terminals here (blocked: load_crashed)'
    ],
    [
      'a silent preflight',
      { nativePreflight: async () => '' },
      'did not answer its native preflight'
    ]
  ])('falls back to Electron on %s and says why', async (_name, overrides, reason) => {
    const selection = await selectServeRuntime(input(overrides))
    expect(selection).toEqual({ kind: 'electron', reason: expect.stringContaining(reason) })
  })
})
