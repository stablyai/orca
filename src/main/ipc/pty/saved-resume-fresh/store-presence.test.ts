import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

vi.mock('../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  getSharedClient: () => ({
    readNativeChat: async (request: { dbPath: string; sessionId: string }) =>
      readOpenCodeSessionPresence(request.dbPath, request.sessionId)
  })
}))

let root: string
const posixIt = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-saved-resume-store-')))
})

afterEach(() => {
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
    ['settings are unknown', { settings: undefined }]
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
  const project = (cwd = root) => join(root, 'claude', 'projects', encodeClaudeProjectPath(cwd))

  it('finds a transcript named for the session in any project folder', async () => {
    writeStoreFile(join(project('/moved/elsewhere'), `${CLAUDE_ID}.jsonl`), CLAUDE_HEADER)
    mkdirSync(project(), { recursive: true })
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('found')
  })

  it('finds a differently named transcript by the session id its records carry', async () => {
    writeStoreFile(join(project(), 'renamed.jsonl'), CLAUDE_HEADER)
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('found')
  })

  it('misses only when every transcript names another session and the folder project exists', async () => {
    writeStoreFile(join(project(), 'other.jsonl'), CLAUDE_HEADER.replaceAll(CLAUDE_ID, 'other-id'))
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('missing')
    writeStoreFile(join(project(), 'older.jsonl'), CLAUDE_SUMMARY_HEADER)
    await expect(probeSavedResumeStore(claudeQuery())).resolves.toBe('unknown')
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
