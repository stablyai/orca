import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectClaudeUsageHistory, projectEventUsageHistory } from './usage-history-projection'
import { groupUsageHistory, totalUsageHistory } from '../../shared/usage-history-aggregation'
import type { UsageHistoryRow } from '../../shared/usage-history-types'
import type { CodexUsagePersistedFile } from '../codex-usage/types'
import { buildClaudeUsageProjectionIntegrity } from '../claude-usage/transcript-projection-integrity'
import { createUsageAccountRootResolver } from './usage-account-attribution'
import { readUsageSourceCacheForScan, writeUsageSourceCache } from './usage-source-cache-file'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

let root: string
let previousDataRoot: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-usage-account-'))
  homedirMock.mockReturnValue(root)
  previousDataRoot = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = join(root, 'data')
  vi.resetModules()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  if (previousDataRoot === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousDataRoot
  }
  await rm(root, { recursive: true, force: true })
})

function tokensByAccount(rows: UsageHistoryRow[]) {
  return Object.fromEntries(
    groupUsageHistory(rows, 'account', 'Unknown').map((group) => [
      group.rows[0]?.accountId ?? 'unknown',
      group.totalTokens
    ])
  )
}

function codexEvent(minute: number, tokens: number): string {
  return `${JSON.stringify({ timestamp: `2026-10-24T12:${String(minute).padStart(2, '0')}:00Z`, type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.4', last_token_usage: { input_tokens: tokens, output_tokens: 0 } } } })}\n`
}

function claudeTurn(key: string, tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', sessionId: 'same-session', timestamp: '2026-10-24T12:00:00Z', cwd: '/work/folder', requestId: `request-${key}`, message: { id: `message-${key}`, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens, output_tokens: 0 } } })}\n`
}

describe('account provenance on the original collectors', () => {
  it('keeps old persisted history unknown when its source ownership cache is unavailable', async () => {
    const home = join(root, 'data', 'codex-accounts', 'account', 'home')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, '.orca-managed-home'), 'account')
    const path = join(home, 'sessions', 'session.jsonl')
    await writeFile(path, codexEvent(0, 75))
    const loaded = await readUsageSourceCacheForScan<CodexUsagePersistedFile>({
      path: join(root, 'missing-sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'new',
      reuse: false,
      hadPreviousHistory: true
    })
    expect(loaded.accountAttributionAvailable).toBe(false)
    const { scanCodexUsageFiles } = await import('../codex-usage/scanner')
    const rebuilt = await scanCodexUsageFiles(
      [],
      loaded.sources,
      undefined,
      loaded.reuseProjections,
      loaded.accountAttributionAvailable
    )
    expect(tokensByAccount(projectEventUsageHistory('codex', rebuilt.dailyAggregates))).toEqual({
      unknown: 75
    })
    await appendFile(path, codexEvent(1, 25))
    const next = await scanCodexUsageFiles([], rebuilt.processedFiles)
    expect(tokensByAccount(projectEventUsageHistory('codex', next.dailyAggregates))).toEqual({
      account: 25,
      unknown: 75
    })
  })
  it('reuses configured OpenCode account databases with stable session deduplication and unknown legacy ownership', async () => {
    vi.stubEnv('XDG_DATA_HOME', join(root, 'unmanaged'))
    vi.stubEnv('OPENCODE_DB', '')
    const sources = ['a', 'b'].map((accountId) => ({
      accountId,
      path: join(root, accountId, 'opencode')
    }))
    const { writeOpenCodeUsageDatabase } =
      await import('../opencode-usage/opencode-usage-sqlite-fixture')
    const { scanOpenCodeUsageDatabases } = await import('../opencode-usage/scanner')
    const shared = { id: 'shared-session', directory: '/work/folder', tokensInput: 50 }
    const unique = (id: string, tokensInput: number) => ({
      id,
      directory: '/work/folder',
      tokensInput
    })
    for (const source of sources) {
      writeOpenCodeUsageDatabase(join(source.path, 'opencode.db'), {
        generation: 'v2-only',
        v2Sessions: [shared, unique(source.accountId, source.accountId === 'a' ? 100 : 200)]
      })
    }
    const first = await scanOpenCodeUsageDatabases([], [], undefined, sources)
    expect(tokensByAccount(projectEventUsageHistory('opencode', first.dailyAggregates))).toEqual({
      a: 100,
      b: 200,
      unknown: 50
    })
    const persisted = await scanOpenCodeUsageDatabases(
      [],
      JSON.parse(JSON.stringify(first.processedDatabases)),
      undefined,
      sources
    )
    expect(persisted.dailyAggregates).toEqual(first.dailyAggregates)
    for (const database of persisted.processedDatabases) {
      delete database.ownedAccountIds
      for (const day of database.dailyAggregates) {
        delete day.accountId
      }
    }
    const path = join(sources[0].path, 'opencode.db')
    await rm(path)
    writeOpenCodeUsageDatabase(path, {
      generation: 'v2-only',
      v2Sessions: [shared, unique('a', 100), unique('new-session', 25)]
    })
    const oldCache = {
      path: join(root, 'opencode-sources.json'),
      schemaVersion: 4,
      worktreeFingerprint: 'old',
      reuse: true
    }
    await writeUsageSourceCache(oldCache, persisted.processedDatabases)
    const loaded = await readUsageSourceCacheForScan<(typeof persisted.processedDatabases)[number]>(
      { ...oldCache, worktreeFingerprint: 'new', reuse: false }
    )
    expect(loaded.reuseProjections).toBe(false)
    const legacy = await scanOpenCodeUsageDatabases(
      [],
      loaded.sources,
      undefined,
      sources,
      loaded.reuseProjections
    )
    expect(tokensByAccount(projectEventUsageHistory('opencode', legacy.dailyAggregates))).toEqual({
      a: 25,
      unknown: 350
    })
  })
  it('keeps unique Codex events per account and conflicting copied events unknown across persistence and owner deletion', async () => {
    const homes = ['a', 'b'].map((id) => join(root, 'data', 'codex-accounts', id, 'home'))
    for (const [index, home] of homes.entries()) {
      await mkdir(join(home, 'sessions'), { recursive: true })
      await writeFile(join(home, '.orca-managed-home'), ['a', 'b'][index])
    }
    const paths = homes.map((home) => join(home, 'sessions', 'session.jsonl'))
    const meta = `${JSON.stringify({ type: 'session_meta', payload: { id: 'same-session', cwd: '/work/folder' } })}\n`
    const common = codexEvent(0, 50)
    await writeFile(paths[0], meta + common + codexEvent(1, 100))
    await writeFile(paths[1], meta + common + codexEvent(2, 200))
    const { scanCodexUsageFiles } = await import('../codex-usage/scanner')
    const first = await scanCodexUsageFiles([], [])
    expect(tokensByAccount(projectEventUsageHistory('codex', first.dailyAggregates))).toEqual({
      a: 100,
      b: 200,
      unknown: 50
    })
    expect(
      totalUsageHistory(projectEventUsageHistory('codex', first.dailyAggregates)).sessions
    ).toBe(1)
    const second = await scanCodexUsageFiles([], JSON.parse(JSON.stringify(first.processedFiles)))
    expect(second.dailyAggregates).toEqual(first.dailyAggregates)
    await rm(paths[0])
    const reclaimed = await scanCodexUsageFiles([], second.processedFiles)
    expect(tokensByAccount(projectEventUsageHistory('codex', reclaimed.dailyAggregates))).toEqual({
      b: 200,
      unknown: 50
    })
  })

  it('keeps unknown runtime Codex history unknown when copied into the next account home', async () => {
    const runtime = join(root, 'data', 'codex-runtime-home', 'home', 'sessions')
    const home = join(root, 'data', 'codex-accounts', 'next-account', 'home')
    await mkdir(runtime, { recursive: true })
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, '.orca-managed-home'), 'next-account')
    const original = join(runtime, 'original.jsonl')
    const copied = join(home, 'sessions', 'copied.jsonl')
    await writeFile(original, codexEvent(0, 75))
    const { scanCodexUsageFiles } = await import('../codex-usage/scanner')
    const first = await scanCodexUsageFiles([], [])
    await copyFile(original, copied)
    await appendFile(copied, codexEvent(1, 25))
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(tokensByAccount(projectEventUsageHistory('codex', second.dailyAggregates))).toEqual({
      'next-account': 25,
      unknown: 75
    })
    await rm(original)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(tokensByAccount(projectEventUsageHistory('codex', third.dailyAggregates))).toEqual({
      'next-account': 25,
      unknown: 75
    })
  })

  it('retains legacy Codex ownership as unknown while assigning only newly observed dedicated-home events', async () => {
    const home = join(root, 'data', 'codex-accounts', 'account', 'home')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, '.orca-managed-home'), 'account')
    const path = join(home, 'sessions', 'session.jsonl')
    const meta = `${JSON.stringify({ type: 'session_meta', payload: { id: 'same-session', cwd: '/work/folder' } })}\n`
    await writeFile(path, meta + codexEvent(0, 75))
    const { scanCodexUsageFiles } = await import('../codex-usage/scanner')
    const first = await scanCodexUsageFiles([], [])
    for (const file of first.processedFiles) {
      delete file.ownedAccountIds
      for (const day of file.dailyAggregates) {
        delete day.accountId
      }
    }
    await appendFile(path, codexEvent(1, 25))
    const oldCache = {
      path: join(root, 'codex-sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'old',
      reuse: true
    }
    await writeUsageSourceCache(oldCache, first.processedFiles)
    const loaded = await readUsageSourceCacheForScan<(typeof first.processedFiles)[number]>({
      ...oldCache,
      worktreeFingerprint: 'new',
      reuse: false
    })
    const second = await scanCodexUsageFiles(
      [
        { repoId: 'folder-repo', worktreeId: 'folder', path: '/work/folder', displayName: 'Folder' }
      ],
      loaded.sources,
      undefined,
      loaded.reuseProjections
    )
    expect(tokensByAccount(projectEventUsageHistory('codex', second.dailyAggregates))).toEqual({
      account: 25,
      unknown: 75
    })
    expect(second.dailyAggregates.every((day) => day.worktreeId === 'folder')).toBe(true)
  })

  it('keeps distinct Claude turns in dedicated homes and counts a copied turn only once as unknown', async () => {
    const sources = ['a', 'b'].map((accountId) => ({
      path: join(root, accountId, 'projects'),
      accountId
    }))
    for (const source of sources) {
      await mkdir(source.path, { recursive: true })
    }
    const paths = sources.map((source) => join(source.path, 'session.jsonl'))
    await writeFile(paths[0], claudeTurn('shared', 50) + claudeTurn('a', 100))
    await writeFile(paths[1], claudeTurn('shared', 50) + claudeTurn('b', 200))
    const { scanClaudeUsageFiles } = await import('../claude-usage/scanner')
    const first = await scanClaudeUsageFiles(
      [],
      [],
      undefined,
      sources.map((source) => source.path),
      undefined,
      sources
    )
    expect(tokensByAccount(projectClaudeUsageHistory(first.dailyAggregates))).toEqual({
      a: 100,
      b: 200,
      unknown: 50
    })
    const second = await scanClaudeUsageFiles(
      [],
      JSON.parse(JSON.stringify(first.processedFiles)),
      undefined,
      sources.map((source) => source.path),
      undefined,
      sources
    )
    expect(second.dailyAggregates).toEqual(first.dailyAggregates)
    await rm(paths[0])
    const reclaimed = await scanClaudeUsageFiles(
      [],
      second.processedFiles,
      undefined,
      sources.map((source) => source.path),
      undefined,
      sources
    )
    expect(tokensByAccount(projectClaudeUsageHistory(reclaimed.dailyAggregates))).toEqual({
      b: 200,
      unknown: 50
    })
  })

  it('preserves unknown Claude legacy turns and their corrections when new account-attributed turns append', async () => {
    const source = { path: join(root, 'account', 'projects'), accountId: 'account' }
    await mkdir(source.path, { recursive: true })
    const path = join(source.path, 'session.jsonl')
    await writeFile(path, claudeTurn('legacy', 75))
    const { scanClaudeUsageFiles } = await import('../claude-usage/scanner')
    const first = await scanClaudeUsageFiles([], [], undefined, [source.path])
    for (const file of first.processedFiles) {
      delete file.ownedAccountIds
      for (const day of file.dailyAggregates) {
        delete day.accountId
      }
      if (file.parseResumeState) {
        for (const projection of file.parseResumeState.projections) {
          delete projection.accountId
        }
        file.parseResumeState.projectionIntegrity = buildClaudeUsageProjectionIntegrity(file)
      }
    }
    await appendFile(path, claudeTurn('legacy', 90) + claudeTurn('new', 25))
    const { writeClaudeUsageSourceCache, readClaudeUsageSourceCache } =
      await import('../claude-usage/persisted-source-cache')
    const oldCache = {
      path: join(root, 'claude-sources.json'),
      schemaVersion: 7,
      worktreeFingerprint: 'old',
      reuse: true
    }
    await writeClaudeUsageSourceCache(oldCache, first.processedFiles)
    const loaded = await readClaudeUsageSourceCache(
      { ...oldCache, worktreeFingerprint: 'new', reuse: false },
      true
    )
    expect(loaded.reuseProjections).toBe(false)
    const second = await scanClaudeUsageFiles(
      [
        { repoId: 'folder-repo', worktreeId: 'folder', path: '/work/folder', displayName: 'Folder' }
      ],
      loaded.sources,
      undefined,
      [source.path],
      loaded.verifiedSources,
      [source],
      loaded.reuseProjections
    )
    expect(tokensByAccount(projectClaudeUsageHistory(second.dailyAggregates))).toEqual({
      account: 25,
      unknown: 90
    })
    expect(second.dailyAggregates.every((day) => day.worktreeId === 'folder')).toBe(true)
  })

  it('does not infer an account from symlinked shared Claude history or hardlinked Codex storage', async () => {
    const shared = join(root, '.claude', 'projects')
    const linked = join(root, 'linked-projects')
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'claude.jsonl'), claudeTurn('shared', 50))
    await symlink(shared, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const accountHome = join(root, 'account-home')
    await mkdir(accountHome)
    await symlink(
      shared,
      join(accountHome, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(
      await createUsageAccountRootResolver([{ path: accountHome, accountId: 'wrong' }])(
        join(accountHome, 'projects', 'claude.jsonl')
      )
    ).toBeNull()
    const { scanClaudeUsageFiles } = await import('../claude-usage/scanner')
    const claude = await scanClaudeUsageFiles([], [], undefined, [linked], undefined, [
      { path: linked, accountId: 'wrong' }
    ])
    expect(tokensByAccount(projectClaudeUsageHistory(claude.dailyAggregates))).toEqual({
      unknown: 50
    })
    const home = join(root, 'data', 'codex-accounts', 'linked', 'home')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, '.orca-managed-home'), 'linked')
    const external = join(root, 'codex.jsonl')
    await writeFile(external, codexEvent(0, 75))
    await link(external, join(home, 'sessions', 'codex.jsonl'))
    const { scanCodexUsageFiles } = await import('../codex-usage/scanner')
    const codex = await scanCodexUsageFiles([], [])
    expect(tokensByAccount(projectEventUsageHistory('codex', codex.dailyAggregates))).toEqual({
      unknown: 75
    })
  })
})
