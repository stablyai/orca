import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { open, opendir, stat } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { encodeClaudeProjectPath } from '../../../ai-vault/claude-project-dir-encoding'
import { readOpenCodeSessionPresence } from '../../../native-chat/transcript-opencode-session-presence'
import {
  CLAUDE_HEADER,
  CLAUDE_ID,
  CLAUDE_SUMMARY_HEADER,
  CODEX_HEADER,
  CODEX_ID,
  CODEX_ROLLOUT,
  OPENCODE_ID,
  PI_FILE,
  PI_HEADER,
  PI_ID,
  codexSessionsDay,
  writeOpenCodeDatabase,
  writeStoreFile
} from './agent-store.test-fixture'
import { probeSavedResumeStore } from './store-presence'
import type { SavedResumeStoreQuery } from './store-query'
import { findStoreFile, newStoreReadBudget } from './store-walk'

const worker = vi.hoisted(() => ({
  read: null as
    | null
    | ((request: { dbPath: string; sessionId: string }, signal?: AbortSignal) => Promise<unknown>)
}))
vi.mock('../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  getSharedClient: () => ({
    readNativeChat: async (request: { dbPath: string; sessionId: string }, signal?: AbortSignal) =>
      worker.read
        ? worker.read(request, signal)
        : readOpenCodeSessionPresence(request.dbPath, request.sessionId)
  })
}))
// Count the store operations a check performs, to hold its cost to its trigger's population.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual: typeof FsPromises = await importOriginal()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    opendir: vi.fn(actual.opendir),
    open: vi.fn(actual.open)
  }
})

let root: string
const posixIt = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-saved-resume-store-')))
})

afterEach(() => {
  worker.read = null
  vi.mocked(stat).mockClear()
  vi.mocked(open).mockClear()
  rmSync(root, { recursive: true, force: true })
})

function query(overrides: Partial<SavedResumeStoreQuery> = {}): SavedResumeStoreQuery {
  const codexHome = join(root, 'codex')
  return {
    agent: 'codex',
    providerSession: { key: 'session_id', id: CODEX_ID },
    launchEnv: { HOME: root, SHELL: '/bin/zsh', CODEX_HOME: codexHome, ORCA_CODEX_HOME: codexHome },
    cwd: root,
    codexHome: { selected: codexHome, verified: false },
    recipeArgs: '',
    settings: { codexManagedAccounts: [] },
    ...overrides
  }
}

describe('Codex store', () => {
  it.each([
    ['a plain rollout', CODEX_ROLLOUT],
    ['a compressed rollout', `${CODEX_ROLLOUT}.zst`],
    [
      'a reverted thread rollout',
      CODEX_ROLLOUT.replace('.jsonl', '_019f1abd-0000-7000-8000-000000000001.jsonl')
    ]
  ])('finds %s', async (_label, name) => {
    writeStoreFile(join(codexSessionsDay(join(root, 'codex')), name), CODEX_HEADER)
    await expect(probeSavedResumeStore(query())).resolves.toBe('found')
  })

  it('finds an archived conversation, and misses only after both trees were read', async () => {
    writeStoreFile(
      join(codexSessionsDay(join(root, 'codex')), 'rollout-2026-06-30T10-00-00-other.jsonl'),
      CODEX_HEADER
    )
    await expect(probeSavedResumeStore(query())).resolves.toBe('missing')
    writeStoreFile(join(root, 'codex', 'archived_sessions', CODEX_ROLLOUT), CODEX_HEADER)
    await expect(probeSavedResumeStore(query())).resolves.toBe('found')
  })

  it('counts the verified original home as found even when the selected home lacks it', async () => {
    mkdirSync(join(root, 'codex', 'sessions'), { recursive: true })
    const verified = query({ codexHome: { selected: join(root, 'codex'), verified: true } })
    await expect(probeSavedResumeStore(verified)).resolves.toBe('found')
  })

  it.each<[string, Partial<SavedResumeStoreQuery>]>([
    ['the sessions root is absent', {}],
    [
      'a custom CODEX_HOME points elsewhere',
      { launchEnv: { HOME: root, CODEX_HOME: '/elsewhere' } }
    ],
    [
      'shared history may still be linking in from other accounts',
      { settings: { codexManagedAccounts: [{ id: 'a' }] as never } }
    ],
    ['settings are unknown', { settings: undefined }],
    [
      "the spawn's CODEX_HOME disagrees with the routed home",
      { launchEnv: { HOME: root, CODEX_HOME: '/other', ORCA_CODEX_HOME: '/other' } }
    ]
  ])('stays unknown when %s', async (_label, overrides) => {
    await expect(probeSavedResumeStore(query(overrides))).resolves.toBe('unknown')
  })

  posixIt('stays unknown when a day folder cannot be read', async () => {
    const day = codexSessionsDay(join(root, 'codex'))
    writeStoreFile(join(day, 'rollout-2026-06-30T10-00-00-other.jsonl'), CODEX_HEADER)
    chmodSync(day, 0o000)
    try {
      await expect(probeSavedResumeStore(query())).resolves.toBe('unknown')
    } finally {
      chmodSync(day, 0o755)
    }
  })
})

describe('Codex check cost', () => {
  it('opens the same folders for N and 10N rollouts through the restore check', async () => {
    const opens = async (count: number) => {
      const home = join(root, `codex-${count}`)
      for (let index = 0; index < count; index += 1) {
        writeStoreFile(
          join(codexSessionsDay(home), `rollout-2026-06-30T10-00-00-${index}.jsonl`),
          ''
        )
      }
      vi.mocked(opendir).mockClear()
      const probe = query({
        launchEnv: { HOME: root, SHELL: '/bin/zsh', CODEX_HOME: home, ORCA_CODEX_HOME: home },
        codexHome: { selected: home, verified: false }
      })
      await expect(probeSavedResumeStore(probe)).resolves.toBe('missing')
      return vi.mocked(opendir).mock.calls.length
    }
    expect([await opens(40), await opens(400)]).toEqual([5, 5])
  })
})

describe('bounded walk', () => {
  function writeRollouts(count: number): string {
    const day = codexSessionsDay(join(root, `codex-${count}`))
    for (let index = 0; index < count; index += 1) {
      writeStoreFile(join(day, `rollout-2026-06-30T10-00-00-${index}.jsonl`), '')
    }
    return join(root, `codex-${count}`, 'sessions')
  }

  it('reads each entry once, so 10N rollouts cost 10x, and a cap ends in unknown', async () => {
    const used = async (count: number) => {
      const budget = newStoreReadBudget()
      const start = budget.entries
      await expect(findStoreFile(writeRollouts(count), 3, () => false, budget)).resolves.toBe(
        'missing'
      )
      return start - budget.entries
    }
    const small = await used(40)
    const large = await used(400)
    expect(small).toBe(40 + 3)
    expect(large).toBe(400 + 3)
    const capped = { ...newStoreReadBudget(), entries: 100 }
    await expect(findStoreFile(writeRollouts(150), 3, () => false, capped)).resolves.toBe('unknown')
  })
})

describe('Claude store', () => {
  const claudeQuery = (overrides: Partial<SavedResumeStoreQuery> = {}) =>
    query({
      agent: 'claude',
      providerSession: { key: 'session_id', id: CLAUDE_ID },
      launchEnv: { HOME: root, SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: join(root, 'claude') },
      ...overrides
    })
  const project = (cwd = root, home = join(root, 'claude')) =>
    join(home, 'projects', encodeClaudeProjectPath(cwd))

  it('finds a transcript named for the session in any project folder', async () => {
    writeStoreFile(join(project('/moved/elsewhere'), `${CLAUDE_ID}.jsonl`), CLAUDE_HEADER)
    mkdirSync(project(), { recursive: true })
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('found')
  })

  it('finds a recorded transcript of another name after it moved to another project', async () => {
    writeStoreFile(join(project('/moved/elsewhere'), 'renamed.jsonl'), CLAUDE_HEADER)
    mkdirSync(project(), { recursive: true })
    const moved = claudeQuery({
      providerSession: {
        key: 'session_id',
        id: CLAUDE_ID,
        transcriptPath: join(project(), 'renamed.jsonl')
      }
    })
    await expect(probeSavedResumeStore(moved)).resolves.toBe('found')
  })

  it('misses by filename alone, whatever the other transcripts begin with or how many there are', async () => {
    writeStoreFile(join(project(), 'older.jsonl'), CLAUDE_SUMMARY_HEADER)
    for (let index = 0; index < 1_100; index += 1) {
      writeStoreFile(
        join(project(), `other-${index}.jsonl`),
        CLAUDE_HEADER.replaceAll(CLAUDE_ID, `x${index}`)
      )
    }
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('missing')
    expect(open).not.toHaveBeenCalled()
  })

  it('stays unknown without the launch folder project or an existing store', async () => {
    writeStoreFile(
      join(project('/another'), 'other.jsonl'),
      CLAUDE_HEADER.replaceAll(CLAUDE_ID, 'x')
    )
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('unknown')
    rmSync(join(root, 'claude'), { recursive: true, force: true })
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('unknown')
  })

  it('costs one check per project folder, so 10N folders cost 10x, and too many is unknown', async () => {
    const checks = async (folders: number) => {
      rmSync(join(root, 'claude'), { recursive: true, force: true })
      mkdirSync(project(), { recursive: true })
      for (let index = 1; index < folders; index += 1) {
        mkdirSync(project(`/p/${index}`), { recursive: true })
      }
      vi.mocked(stat).mockClear()
      await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('missing')
      return vi.mocked(stat).mock.calls.length
    }
    expect([await checks(50), await checks(500)]).toEqual([50, 500])
    for (let index = 500; index <= 5_000; index += 1) {
      mkdirSync(project(`/p/${index}`), { recursive: true })
    }
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('unknown')
    expect(open).not.toHaveBeenCalled()
  })

  describe('an account pane, whose shell function reads its profile pointer at launch', () => {
    const profileHome = () => join(root, 'profile')
    const pointer = () => join(root, 'pointer')
    const accountQuery = (env: Record<string, string> = {}) =>
      claudeQuery({
        launchEnv: {
          HOME: root,
          SHELL: '/bin/zsh',
          ORCA_CLAUDE_PROFILE_POINTER: pointer(),
          ...env
        }
      })

    beforeEach(() => {
      // The profile keeps its own projects; the folder the spawn env names does not have it.
      writeStoreFile(join(project(root, profileHome()), `${CLAUDE_ID}.jsonl`), CLAUDE_HEADER)
      mkdirSync(project(), { recursive: true })
    })

    it('reads the profile the pointer names, not the injected folder', async () => {
      writeStoreFile(pointer(), `${profileHome()}\n`)
      const injected = join(root, 'claude')
      await expect(
        probeSavedResumeStore(
          accountQuery({ CLAUDE_CONFIG_DIR: injected, ORCA_CLAUDE_INJECTED_CONFIG_DIR: injected })
        )
      ).resolves.toBe('found')
    })

    it.each<[string, () => void, Record<string, string>]>([
      ['a relative pointer target', () => writeStoreFile(pointer(), 'profile'), {}],
      ['a guest-home pointer', () => {}, { ORCA_CLAUDE_PROFILE_POINTER: '~/.orca/pointer' }],
      [
        'a startup file that sets its own config folder',
        () => {
          writeStoreFile(pointer(), profileHome())
          writeStoreFile(join(root, '.zshrc'), `export CLAUDE_CONFIG_DIR=${join(root, 'mine')}\n`)
        },
        {}
      ]
    ])('stays unknown for %s', async (_label, write, env) => {
      write()
      await expect(probeSavedResumeStore(accountQuery(env))).resolves.toBe('unknown')
    })

    posixIt('stays unknown when the pointer cannot be read', async () => {
      writeStoreFile(pointer(), profileHome())
      chmodSync(pointer(), 0o000)
      try {
        await expect(probeSavedResumeStore(accountQuery())).resolves.toBe('unknown')
      } finally {
        chmodSync(pointer(), 0o600)
      }
    })
  })
})

describe('the check limiter', () => {
  const openCodeQuery = () =>
    query({
      agent: 'opencode',
      providerSession: { key: 'session_id', id: OPENCODE_ID },
      launchEnv: {
        HOME: root,
        SHELL: '/bin/zsh',
        XDG_DATA_HOME: join(root, 'data'),
        OPENCODE_DB: 'opencode.db'
      }
    })
  beforeEach(() => {
    writeOpenCodeDatabase(join(root, 'data', 'opencode', 'opencode.db'), 'session_v2', [])
  })

  it('runs at most two checks at once and hands each freed slot on', async () => {
    let inFlight = 0
    let most = 0
    const signals: unknown[] = []
    worker.read = async (_request, signal) => {
      signals.push(signal)
      most = Math.max(most, (inFlight += 1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return 'missing'
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, () => probeSavedResumeStore(openCodeQuery()))
    )
    expect(results).toEqual(Array(5).fill('missing'))
    expect(most).toBe(2)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })

  it('ends a check waiting behind stuck worker reads as unknown by its deadline', async () => {
    worker.read = (_request, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason))
      )
    const started = Date.now()
    const results = await Promise.all(
      Array.from({ length: 3 }, () => probeSavedResumeStore(openCodeQuery()))
    )
    expect(results).toEqual(['unknown', 'unknown', 'unknown'])
    expect(Date.now() - started).toBeLessThan(newStoreReadBudget().deadline - Date.now() + 1_000)
  }, 10_000)
})

describe('OpenCode store', () => {
  const dataHome = () => join(root, 'data')
  const dbPath = () => join(dataHome(), 'opencode', 'opencode.db')
  const openCodeQuery = () =>
    query({
      agent: 'opencode',
      providerSession: { key: 'session_id', id: OPENCODE_ID },
      launchEnv: {
        HOME: root,
        SHELL: '/bin/zsh',
        XDG_DATA_HOME: dataHome(),
        OPENCODE_DB: 'opencode.db'
      }
    })

  it.each(['session_v2', 'session'] as const)('reads the %s dialect table', async (table) => {
    writeOpenCodeDatabase(dbPath(), table, [OPENCODE_ID])
    await expect(probeSavedResumeStore(openCodeQuery())).resolves.toBe('found')
    rmSync(dbPath())
    writeOpenCodeDatabase(dbPath(), table, ['ses_other'])
    await expect(probeSavedResumeStore(openCodeQuery())).resolves.toBe('missing')
  })

  it("reads an account pane's own data folder, which its shell re-exports after startup files", async () => {
    writeStoreFile(join(root, '.zshrc'), `export XDG_DATA_HOME=${join(root, 'elsewhere')}\n`)
    await expect(probeSavedResumeStore(openCodeQuery())).resolves.toBe('unknown')
    const account = join(root, 'account-data')
    writeOpenCodeDatabase(join(account, 'opencode', 'opencode.db'), 'session_v2', [OPENCODE_ID])
    const accountQuery = query({
      agent: 'opencode',
      providerSession: { key: 'session_id', id: OPENCODE_ID },
      launchEnv: {
        HOME: root,
        SHELL: '/bin/zsh',
        ORCA_DATA_ACCOUNT_DATA_HOME: account,
        ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
      }
    })
    await expect(probeSavedResumeStore(accountQuery)).resolves.toBe('found')
  })

  it('stays unknown for an unrecognized schema, legacy file sessions, or another channel database', async () => {
    writeOpenCodeDatabase(dbPath(), 'session_v2', ['ses_other'])
    expect(readOpenCodeSessionPresence(dbPath(), OPENCODE_ID)).toBe('missing')
    mkdirSync(join(dataHome(), 'opencode', 'storage', 'session'), { recursive: true })
    await expect(probeSavedResumeStore(openCodeQuery())).resolves.toBe('unknown')
    rmSync(join(dataHome(), 'opencode', 'storage'), { recursive: true })
    writeOpenCodeDatabase(join(dataHome(), 'opencode', 'opencode-dev.db'), 'session_v2', [])
    await expect(probeSavedResumeStore(openCodeQuery())).resolves.toBe('unknown')
    const unrecognized = join(root, 'unrecognized.db')
    const db = new SyncDatabase(unrecognized)
    db.exec('CREATE TABLE conversation (id TEXT PRIMARY KEY)')
    db.close()
    expect(readOpenCodeSessionPresence(unrecognized, OPENCODE_ID)).toBe('unknown')
  })
})

describe('Pi store', () => {
  const sessions = () => join(root, 'pi', 'agent', 'sessions')
  const piQuery = (transcriptPath: string, recipeArgs = '') =>
    query({
      agent: 'pi',
      providerSession: { key: 'session_id', id: PI_ID, transcriptPath },
      recipeArgs
    })

  it('finds the exact file, or the same session moved within its store', async () => {
    const exact = writeStoreFile(join(sessions(), '--tmp-stream-pi--', PI_FILE), PI_HEADER)
    await expect(probeSavedResumeStore(piQuery(exact))).resolves.toBe('found')
    const gone = join(sessions(), '--tmp-old-folder--', PI_FILE)
    await expect(probeSavedResumeStore(piQuery(gone))).resolves.toBe('found')
    rmSync(exact)
    await expect(probeSavedResumeStore(piQuery(gone))).resolves.toBe('missing')
  })

  it('stays unknown outside a sessions tree or with a custom session folder', async () => {
    mkdirSync(sessions(), { recursive: true })
    await expect(probeSavedResumeStore(piQuery(join(root, 'loose', PI_FILE)))).resolves.toBe(
      'unknown'
    )
    const gone = join(sessions(), '--tmp--', PI_FILE)
    await expect(probeSavedResumeStore(piQuery(gone, '--session-dir /x'))).resolves.toBe('unknown')
  })
})
