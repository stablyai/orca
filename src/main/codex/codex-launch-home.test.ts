import * as fsPromises from 'node:fs/promises'
import {
  prepareCodexLaunchHome,
  prepareLegacySharedCodexSessionResume
} from './codex-legacy-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseToml } from 'smol-toml'
import { applyCodexSharedStoreConfig } from './codex-shared-store-config'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_STORE_DIRECTORIES,
  codexConversationStore,
  codexLoginHome,
  discoverCodexStoreHomes,
  reconcileCodexOverlaySignOut,
  resolveCodexLaunchHome
} from './codex-launch-home'
import { readConfiguredCodexSqliteHome, resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import { safeRemoveTree } from '../pty/overlay-mirror'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual, link: vi.fn(actual.link) }
})

vi.mock('./codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncSystemCodexResourcesIntoManagedHome: vi.fn(),
  getSystemCodexHomePath: () => system,
  getOrcaManagedCodexHomePath: () => join(root, 'legacy'),
  getCodexSessionBackfillStateDirPath: () => join(root, 'backfill')
}))

const originalFsPromises = await vi.importActual<typeof fsPromises>('node:fs/promises')

let root: string
let system: string
let accounts: string
let a: string
let b: string
beforeEach(() => {
  vi.mocked(fsPromises.link).mockImplementation(originalFsPromises.link)
  root = mkdtempSync(join(tmpdir(), 'codex-store-overlay-'))
  system = join(root, 'system')
  accounts = join(root, 'codex-accounts')
  a = account('a')
  b = account('b')
  mkdirSync(system)
  writeFileSync(join(system, 'config.toml'), 'model = "test"\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  safeRemoveTree(root)
})

function account(id: string): string {
  const home = join(accounts, id, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), id)
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ account: id }))
  writeFileSync(join(home, 'config.toml'), '# legacy settings stay here\n')
  return home
}
function launch(login: string | null, conversationHome?: string, readOnly = false): string {
  const home = resolveCodexLaunchHome({
    selectedAccount: login ? { homePath: login } : null,
    conversationHome,
    systemHome: system,
    accountsRoot: accounts,
    readOnly
  })
  return home ?? system
}

describe('Codex login overlays over conversation stores', () => {
  it('atomically links the store directories, leaving login and indexes private', () => {
    const predicted = launch(a, undefined, true)
    expect(existsSync(predicted)).toBe(false)
    const overlay = launch(a)
    expect(overlay).toBe(predicted)
    for (const entry of CODEX_STORE_DIRECTORIES) {
      expect(realpathSync(join(overlay, entry))).toBe(realpathSync(join(system, entry)))
    }
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('a')
    expect(resolveEffectiveCodexSqliteHome(overlay)).toBe(realpathSync(system))
    expect(readFileSync(join(overlay, 'config.toml'), 'utf8')).toContain(
      'cli_auth_credentials_store = "file"'
    )
    for (const entry of ['tmp', 'log', 'memories']) {
      mkdirSync(join(overlay, entry))
      expect(lstatSync(join(overlay, entry)).isSymbolicLink()).toBe(false)
      expect(existsSync(join(system, entry))).toBe(false)
    }
    writeFileSync(join(overlay, 'session_index.jsonl'), 'private index\n')
    writeFileSync(join(overlay, 'models_cache.json'), '{}')
    expect(existsSync(join(system, 'session_index.jsonl'))).toBe(false)
    expect(launch(a)).toBe(overlay)
    expect(readFileSync(join(a, 'config.toml'), 'utf8')).toBe('# legacy settings stay here\n')
  })

  it('A → B → A reads one current rollout after undo, including across a legacy store', () => {
    const sqlite = join(root, 'database')
    mkdirSync(sqlite)
    writeFileSync(join(system, 'config.toml'), `sqlite_home = ${JSON.stringify(sqlite)}\n`)
    const first = launch(a)
    const second = launch(b, first)
    const db = new DatabaseSync(join(resolveEffectiveCodexSqliteHome(first), 'state_5.sqlite'))
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); INSERT INTO threads VALUES ('T', 'before-undo')"
    )
    const switched = new DatabaseSync(
      join(resolveEffectiveCodexSqliteHome(second), 'state_5.sqlite')
    )
    switched.exec("UPDATE threads SET rollout_path = 'after-undo' WHERE id = 'T'")
    switched.close()
    const resumed = launch(a, second)
    expect(resumed).toBe(first)
    expect(resolveEffectiveCodexSqliteHome(resumed)).toBe(resolveEffectiveCodexSqliteHome(second))
    expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('T')).toEqual({
      rollout_path: 'after-undo'
    })
    db.close()

    mkdirSync(join(a, 'sessions'), { recursive: true })
    writeFileSync(join(a, 'sessions', 'old.jsonl'), 'legacy conversation')
    expect(launch(a, a)).toBe(a)
    const oldUnderB = launch(b, a)
    expect(codexConversationStore(oldUnderB)).toBe(realpathSync(a))
    expect(readFileSync(join(oldUnderB, 'sessions', 'old.jsonl'), 'utf8')).toBe(
      'legacy conversation'
    )
    expect(resolveEffectiveCodexSqliteHome(oldUnderB)).toBe(realpathSync(a))
    expect(readFileSync(join(a, 'config.toml'), 'utf8')).toBe('# legacy settings stay here\n')
    expect(existsSync(join(system, 'sessions', 'old.jsonl'))).toBe(false)
    expect(discoverCodexStoreHomes(accounts)).toEqual(
      expect.arrayContaining([a, b, oldUnderB, realpathSync(system)])
    )
  })

  it('keys overlays by canonical store and never retargets a previous overlay', () => {
    const old = launch(a)
    const nextStore = join(root, 'next-store')
    mkdirSync(nextStore)
    const next = launch(a, nextStore)
    expect(next).not.toBe(old)
    expect(codexConversationStore(old)).toBe(realpathSync(system))
    expect(codexConversationStore(next)).toBe(realpathSync(nextStore))
  })

  it('propagates logout but preserves an atomic re-auth newer than the missing link', () => {
    const overlay = launch(a)
    unlinkSync(join(overlay, 'auth.json'))
    reconcileCodexOverlaySignOut(dirname(a), a)
    expect(existsSync(join(a, 'auth.json'))).toBe(false)

    writeFileSync(join(a, 'auth.json'), '{"account":"new login"}')
    launch(a)
    unlinkSync(join(overlay, 'auth.json'))
    writeFileSync(join(a, 'reauth.json'), '{"account":"reauthenticated"}')
    renameSync(join(a, 'reauth.json'), join(a, 'auth.json'))
    launch(a)
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('reauthenticated')
  })

  it('keeps the owning store when sessions redirect elsewhere', () => {
    const redirected = join(root, 'rollouts')
    mkdirSync(redirected)
    symlinkSync(
      redirected,
      join(system, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const sqlite = join(root, 'database')
    writeFileSync(join(system, 'config.toml'), `"sqlite_home" = '''${sqlite}'''\n`)
    const overlay = launch(a)
    expect(codexConversationStore(overlay)).toBe(realpathSync(system))
    expect(realpathSync(join(overlay, 'sessions'))).toBe(realpathSync(redirected))
    expect(resolveEffectiveCodexSqliteHome(overlay)).toBe(sqlite)
    expect(codexConversationStore(launch(b, overlay))).toBe(realpathSync(system))
  })

  it('retains an offline store without blocking healthy discovery', () => {
    const overlay = launch(a)
    const owner = codexConversationStore(overlay)
    const offline = join(root, 'offline')
    renameSync(system, offline)
    const inventory = discoverCodexStoreHomes(accounts)
    expect(inventory).toContain(overlay)
    expect(inventory).toContain(owner)
    const healthy = join(root, 'healthy')
    mkdirSync(healthy)
    expect(codexConversationStore(launch(b, healthy))).toBe(realpathSync(healthy))
    expect(codexConversationStore(overlay)).toBe(owner)
    renameSync(offline, system)
    expect(realpathSync(join(overlay, 'sessions'))).toBe(realpathSync(join(system, 'sessions')))
  })

  it('parses quoted multiline settings and removes their complete assignment spans', () => {
    const sqlite = join(root, 'db with spaces')
    const config = [
      '"sqlite\\u005fhome" = """\\',
      `  ${sqlite.replaceAll('\\', '\\\\')}"""`,
      '"cli_auth_credentials_store" = """',
      'auto"""',
      'developer_instructions = """',
      'sqlite_home = "not a setting"',
      '[fake_table]',
      '"""',
      '[model_providers.local]',
      'base_url = "http://localhost:1234"',
      ''
    ].join('\r\n')
    expect(readConfiguredCodexSqliteHome(config, system)).toBe(sqlite)
    writeFileSync(join(system, 'config.toml'), config)
    const overlay = launch(a)
    const generated = applyCodexSharedStoreConfig(config, overlay)
    const parsed = parseToml(generated)
    expect(parsed.sqlite_home).toBe(sqlite)
    expect(parsed.cli_auth_credentials_store).toBe('file')
    expect(parsed.developer_instructions).toContain('[fake_table]')
    expect(applyCodexSharedStoreConfig(generated, overlay)).toBe(generated)
    expect(readConfiguredCodexSqliteHome("'sqlite_home' = ''' relative path '''", system)).toBe(
      join(system, ' relative path ')
    )
  })

  it.each(['', null])(
    'does not promote store policy to an empty or missing config (%s)',
    (source) => {
      const overlay = launch(a)
      if (source === null) {
        unlinkSync(join(system, 'config.toml'))
      } else {
        writeFileSync(join(system, 'config.toml'), source)
      }
      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: overlay, systemHomePath: system })
      const restored = existsSync(join(system, 'config.toml'))
        ? readFileSync(join(system, 'config.toml'), 'utf8')
        : ''
      const parsed = parseToml(restored)
      expect(parsed.sqlite_home).toBeUndefined()
      expect(parsed.cli_auth_credentials_store).toBeUndefined()
    }
  )

  it.each(['gateway', 'ollama', 'lmstudio', 'openai', 'signed-out'])(
    'keeps fileless %s providers usable over another store',
    (provider) => {
      const config = `model_provider = "${provider}"\n${
        provider === 'gateway'
          ? '[model_providers.gateway]\nname = "Gateway"\nbase_url = "http://localhost:1234"\nenv_key = "FIXTURE_GATEWAY_TOKEN"\n'
          : ''
      }`
      writeFileSync(join(system, 'config.toml'), config)
      expect(launch(null, a, true)).toBe(system)
      expect(launch(null, a)).toBe(system)
      expect(
        resolveCodexLaunchHome({ selectedAccount: null, storeHome: a, systemHome: system })
      ).toBeUndefined()
      expect(parseToml(readFileSync(join(system, 'config.toml'), 'utf8')).model_provider).toBe(
        provider
      )
      expect(existsSync(join(accounts, 'system', 'overlays'))).toBe(false)
      expect(existsSync(join(system, 'auth.json'))).toBe(false)
    }
  )

  it('keeps file-backed System default on the named-store overlay', () => {
    expect(resolveCodexLaunchHome({ selectedAccount: null, systemHome: system })).toBeUndefined()
    expect(launch(null, a)).toBe(system)
    writeFileSync(join(system, 'auth.json'), '{"system":true}')
    const overlay = launch(null, a)
    expect(codexLoginHome(overlay, system)).toBe(system)
    expect(codexConversationStore(overlay)).toBe(realpathSync(a))
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toContain('system')
  })
})

const threadId = 'abcdef00-1234-4321-9999-cafecafecafe'
function sourceRollout(): string {
  const file = join(a, 'sessions', '2026', '10', '28', `rollout-${threadId}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{"type":"session_meta"}\n')
  return file
}
function targetRollout(): string {
  return join(system, 'sessions', '2026', '10', '28', `rollout-${threadId}.jsonl`)
}

it('predicts without copying and awaits actual native preparation before returning launch inputs', async () => {
  const source = sourceRollout()
  const { link } = originalFsPromises
  let entered!: () => void
  const began = new Promise<void>((done) => {
    entered = done
  })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  vi.mocked(fsPromises.link).mockImplementation(async (from, to) => {
    if (to === targetRollout()) {
      entered()
      await gate
    }
    return link(from, to)
  })
  expect(launch(null, a, true)).toBe(system)
  expect(existsSync(targetRollout())).toBe(false)
  const record = agentSessionRecordFixture({
    sessionId: 'native',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: a },
    providerHandleChain: [
      {
        linkId: 'link',
        handle: codexProviderHandle(threadId),
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  })
  writeFileSync(join(system, 'auth.json'), '{}')
  record.accountHome = { variable: 'CODEX_HOME', path: launch(null, a) }
  unlinkSync(join(system, 'auth.json'))
  const resolver = createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => root,
    resolveCommand: () => 'codex',
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({
      CODEX_HOME: '/custom/typed-input',
      OPENAI_API_KEY: 'fixture-env-input'
    })
  })
  let settled = false
  const pending = resolver({
    identity: {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      hostId: record.location.executionHostId,
      agent: record.provider,
      providerHandle: codexProviderHandle(threadId)
    }
  }).then((value) => {
    settled = true
    return value
  })
  await began
  expect(settled).toBe(false)
  expect(existsSync(targetRollout())).toBe(false)
  release()
  const result = await pending
  expect(result.codexHome).toBe(system)
  expect(result.env.CODEX_HOME).toBe(system)
  expect(result.env.OPENAI_API_KEY).toBe('fixture-env-input')
  expect(readFileSync(targetRollout(), 'utf8')).toBe(readFileSync(source, 'utf8'))
})

it('uses main no-overwrite copy fallback, matching-target retry and conflicting-target failure', async () => {
  const transcriptPath = sourceRollout()
  const { link } = originalFsPromises
  vi.mocked(fsPromises.link).mockImplementation(async (from, to) => {
    if (from === transcriptPath) {
      throw Object.assign(new Error('different volume'), { code: 'EXDEV' })
    }
    return link(from, to)
  })
  const options = { selectedAccount: null, conversationHome: a, transcriptPath, systemHome: system }
  await expect(prepareCodexLaunchHome(options)).resolves.toBeUndefined()
  expect(readFileSync(targetRollout(), 'utf8')).toBe(readFileSync(transcriptPath, 'utf8'))
  await expect(prepareCodexLaunchHome(options)).resolves.toBeUndefined()
  unlinkSync(targetRollout())
  writeFileSync(targetRollout(), 'other conversation')
  await expect(prepareCodexLaunchHome(options)).rejects.toThrow('Retry resume')
  expect(readFileSync(targetRollout(), 'utf8')).toBe('other conversation')
  expect(readFileSync(transcriptPath, 'utf8')).toBe('{"type":"session_meta"}\n')
})

it('awaits History/adoption preparation and propagates materialization failure without fallback', async () => {
  const filePath = sourceRollout()
  const args: AiVaultPrepareSessionResumeArgs = {
    agent: 'codex' as const,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    codexHome: a,
    filePath
  }
  const options = { isHostSystemDefaultRealHomeSelected: () => true, systemCodexHomePath: system }
  await expect(prepareLegacySharedCodexSessionResume(args, options)).resolves.toEqual({
    useRealCodexHome: true
  })
  expect(readFileSync(targetRollout(), 'utf8')).toBe(readFileSync(filePath, 'utf8'))
  unlinkSync(targetRollout())
  writeFileSync(targetRollout(), 'conflict')
  await expect(prepareLegacySharedCodexSessionResume(args, options)).rejects.toThrow('Retry resume')
  expect(readFileSync(targetRollout(), 'utf8')).toBe('conflict')
})

it('leaves a missing native rollout to the existing provider resume/unsaved-thread contract', async () => {
  await expect(
    prepareCodexLaunchHome({
      selectedAccount: null,
      conversationHome: a,
      sessionId: threadId,
      systemHome: system
    })
  ).resolves.toBeUndefined()
  expect(existsSync(targetRollout())).toBe(false)
})
