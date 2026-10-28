import type * as ScanFs from 'node:fs'
import { readdirSync, realpathSync } from 'node:fs'
import { discoverCodexStoreHomes } from '../codex/codex-launch-home'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import { parseSessionCandidates } from './session-scanner-candidate-parse'
import type { SessionFileCandidate } from './session-scanner-types'
import { createSessionParseStats } from './session-scanner-parse-cache'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  stat,
  appendFile,
  rename,
  readlink,
  readFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getCodexSessionIndexTitleCacheSizeForTest,
  _hasCodexSessionIndexTitleCacheEntryForTest,
  _readCachedCodexSessionIndexTitlesForTest,
  _storeCodexSessionIndexTitleCacheEntryForTest,
  readCodexSessionIndexTitle,
  resetCodexSessionIndexTitleCacheForTests
} from './session-scanner-codex-title-index'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ScanFs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

const CACHE_LIMIT = 64

let tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-title-inventory-'))
  tempRoots.push(root)
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function createCodexHome(index: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-title-index-'))
  tempRoots.push(root)
  const codexHome = join(root, `codex-home-${index}`)
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  await writeFile(
    join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: `session-${index}`, thread_name: `Title ${index}` })}\n`
  )
  return codexHome
}

async function readTitle(codexHome: string, index: number): Promise<string | null> {
  return readCodexSessionIndexTitle(
    join(codexHome, 'sessions', `session-${index}.jsonl`),
    codexHome,
    `session-${index}`
  )
}

describe('codex session index title cache', () => {
  it('returns healthy History titles while a retained store is offline, then observes its return', async () => {
    const root = process.env.ORCA_USER_DATA_PATH!
    const accounts = join(root, 'codex-accounts')
    const healthy = join(accounts, 'healthy', 'home')
    const retained = join(accounts, 'removed', 'overlays', 'b'.repeat(32))
    const remote = join(realpathSync(root), 'removable-store')
    for (const [home, id] of [
      [healthy, 'healthy-thread'],
      [remote, 'retained-thread']
    ]) {
      const sessions = join(home, 'sessions', '2026', '10', '28')
      await mkdir(sessions, { recursive: true })
      await writeFile(
        join(sessions, `rollout-${id}.jsonl`),
        jsonLines([
          { type: 'session_meta', payload: { id, cwd: '/fixture/repo' } },
          {
            timestamp: '2026-10-28T00:00:00Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Fallback title' }]
            }
          }
        ])
      )
    }
    const removedHome = join(accounts, 'removed', 'home')
    for (const [home, id] of [
      [healthy, 'healthy'],
      [removedHome, 'removed']
    ]) {
      await mkdir(home, { recursive: true })
      await writeFile(join(home, '.orca-managed-home'), id)
    }
    await mkdir(retained, { recursive: true })
    await symlink(
      join(remote, 'sessions'),
      join(retained, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const titleIndex = `${jsonLines([{ id: 'retained-thread', thread_name: 'Retained rename', updated_at: '2026-10-28T01:00:00Z' }])}\n`
    await writeFile(join(retained, 'session_index.jsonl'), titleIndex)
    await writeFile(
      join(healthy, 'session_index.jsonl'),
      `${jsonLines([
        { id: 'healthy-thread', thread_name: 'Healthy rename', updated_at: '2026-10-28T01:00:00Z' }
      ])}\n`
    )
    const link = await readlink(join(retained, 'sessions'))
    const offline = join(root, 'unmounted-store')
    await rename(remote, offline)

    for (const restored of [false, false, true]) {
      if (restored) {
        await rename(offline, remote)
      }
      const homes = discoverCodexStoreHomes(accounts)
      expect(homes).toEqual(
        expect.arrayContaining([healthy, retained, join(realpathSync(root), 'removable-store')])
      )
      vi.mocked(readdirSync).mockClear()
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(root),
        additionalCodexSessionsDirs: homes.map((home) => join(home, 'sessions')),
        defaultCodexHomeDir: join(root, 'unused'),
        unlimited: true
      })
      expect(
        result.sessions
          .map(({ sessionId, title }) => ({ sessionId, title }))
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      ).toEqual(
        restored
          ? [
              { sessionId: 'healthy-thread', title: 'Healthy rename' },
              { sessionId: 'retained-thread', title: 'Retained rename' }
            ]
          : [{ sessionId: 'healthy-thread', title: 'Healthy rename' }]
      )
      expect(
        vi.mocked(readdirSync).mock.calls.filter(([path]) => String(path) === accounts)
      ).toHaveLength(1)
      expect(await readlink(join(retained, 'sessions'))).toBe(link)
      expect(await readFile(join(retained, 'session_index.jsonl'), 'utf8')).toBe(titleIndex)
    }
  })

  it.each([2, 20])(
    'inventories once for %i stores through cold/warm scans and cached batches',
    async (count) => {
      const root = process.env.ORCA_USER_DATA_PATH!
      const homes: string[] = []
      const candidates: SessionFileCandidate[] = []
      for (let index = 0; index < count; index++) {
        const home = join(root, 'codex-accounts', `a-${index}`, 'home')
        const overlay = join(root, 'codex-accounts', `a-${index}`, 'overlays', 'a'.repeat(32))
        const sessions = join(home, 'sessions', '2026', '10', '28')
        await mkdir(sessions, { recursive: true })
        await mkdir(overlay, { recursive: true })
        await writeFile(join(home, '.orca-managed-home'), `a-${index}`)
        await symlink(
          join(home, 'sessions'),
          join(overlay, 'sessions'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
        const id = `session-${index}`
        const file = join(sessions, `rollout-${id}.jsonl`)
        await writeFile(
          file,
          jsonLines([
            { type: 'session_meta', payload: { id, cwd: '/fixture/repo' } },
            {
              timestamp: '2026-10-28T00:00:00Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'text', text: 'Fallback title' }]
              }
            }
          ])
        )
        await writeFile(
          join(home, 'session_index.jsonl'),
          jsonLines([
            { id, thread_name: `New ${index}`, updated_at: '2026-10-28T01:00:00.000000002Z' }
          ])
        )
        await writeFile(
          join(overlay, 'session_index.jsonl'),
          jsonLines([
            { id, thread_name: 'Old', updated_at: '2026-10-28T01:00:00.000000001Z' },
            { id: 'unrelated', thread_name: 'Other rename', updated_at: '2026-10-28T02:00:00Z' }
          ])
        )
        const info = await stat(file)
        candidates.push({
          agent: 'codex' as const,
          codexHome: home,
          file: {
            path: file,
            mtimeMs: info.mtimeMs,
            modifiedAt: info.mtime.toISOString(),
            sizeBytes: info.size
          }
        })
        homes.push(home)
      }
      const options = {
        ...isolatedScanRoots(root),
        codexSessionsDir: join(homes[0], 'sessions'),
        additionalCodexSessionsDirs: homes.slice(1).map((home) => join(home, 'sessions')),
        defaultCodexHomeDir: join(root, 'unused'),
        unlimited: true
      }
      const inventoryCount = () =>
        vi
          .mocked(readdirSync)
          .mock.calls.filter(([path]) => String(path) === join(root, 'codex-accounts')).length
      for (let pass = 0; pass < 2; pass++) {
        vi.mocked(readdirSync).mockClear()
        const result = await scanAiVaultSessions(options)
        expect(result.sessions).toHaveLength(count)
        expect(result.sessions.every((session) => session.title.startsWith('New '))).toBe(true)
        expect(inventoryCount()).toBe(1)
      }
      await appendFile(
        join(homes[0], 'session_index.jsonl'),
        `\n${jsonLines([
          { id: 'session-0', thread_name: 'Newest', updated_at: '2026-10-28T03:00:00Z' }
        ])}\n`
      )
      vi.mocked(readdirSync).mockClear()
      const cached = await parseSessionCandidates({
        candidates,
        limit: Infinity,
        platform: process.platform,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        issues: [],
        parseStats: createSessionParseStats()
      })
      expect(cached.find((session) => session.sessionId === 'session-0')?.title).toBe('Newest')
      expect(inventoryCount()).toBe(1)
    }
  )

  it('caps cached title indexes by Codex home', async () => {
    const homes: string[] = []

    for (let index = 0; index < CACHE_LIMIT + 1; index++) {
      const codexHome = await createCodexHome(index)
      homes.push(codexHome)
      expect(await readTitle(codexHome, index)).toBe(`Title ${index}`)
    }

    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[0])).toBe(false)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[CACHE_LIMIT])).toBe(true)
  })

  it('refreshes cache recency when an existing Codex home is reused', async () => {
    const homes: string[] = []
    for (let index = 0; index < CACHE_LIMIT; index++) {
      const codexHome = await createCodexHome(index)
      homes.push(codexHome)
      await readTitle(codexHome, index)
    }

    await readTitle(homes[0], 0)
    const extraHome = await createCodexHome(CACHE_LIMIT)
    await readTitle(extraHome, CACHE_LIMIT)

    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[0])).toBe(true)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(homes[1])).toBe(false)
  })

  it('does not resurrect a pending cache hit after that home is evicted', async () => {
    let resolveSlowTitles: (titles: Map<string, string>) => void = () => {}
    const slowTitles = new Promise<Map<string, string>>((resolve) => {
      resolveSlowTitles = resolve
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('slow-home', 'stable', slowTitles)
    const pendingHit = _readCachedCodexSessionIndexTitlesForTest('slow-home', 'stable')

    for (let index = 0; index < CACHE_LIMIT; index += 1) {
      _storeCodexSessionIndexTitleCacheEntryForTest(
        `replacement-home-${index}`,
        `signature-${index}`,
        Promise.resolve(new Map([[`session-${index}`, `Title ${index}`]]))
      )
    }
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest('slow-home')).toBe(false)

    const titles = new Map([['slow-session', 'Slow title']])
    resolveSlowTitles(titles)

    await expect(pendingHit).resolves.toEqual(titles)
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(CACHE_LIMIT)
    expect(_hasCodexSessionIndexTitleCacheEntryForTest('slow-home')).toBe(false)
  })

  it('does not replace a newer same-home entry when an older cache hit resolves', async () => {
    let resolveOldTitles: (titles: Map<string, string>) => void = () => {}
    const oldTitles = new Promise<Map<string, string>>((resolve) => {
      resolveOldTitles = resolve
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'old', oldTitles)
    const pendingOldHit = _readCachedCodexSessionIndexTitlesForTest('same-home', 'old')

    const newTitles = new Map([['new-session', 'New title']])
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'new', Promise.resolve(newTitles))
    const resolvedOldTitles = new Map([['old-session', 'Old title']])
    resolveOldTitles(resolvedOldTitles)

    await expect(pendingOldHit).resolves.toEqual(resolvedOldTitles)
    await expect(_readCachedCodexSessionIndexTitlesForTest('same-home', 'new')).resolves.toEqual(
      newTitles
    )
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(1)
  })

  it('preserves a newer same-home entry when an older cache hit rejects', async () => {
    let rejectOldTitles: (error: Error) => void = () => {}
    const oldTitles = new Promise<Map<string, string>>((_resolve, reject) => {
      rejectOldTitles = reject
    })
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'old', oldTitles)
    const pendingOldHit = _readCachedCodexSessionIndexTitlesForTest('same-home', 'old')

    const newTitles = new Map([['new-session', 'New title']])
    _storeCodexSessionIndexTitleCacheEntryForTest('same-home', 'new', Promise.resolve(newTitles))
    rejectOldTitles(new Error('old read failed'))

    await expect(pendingOldHit).rejects.toThrow('old read failed')
    await expect(_readCachedCodexSessionIndexTitlesForTest('same-home', 'new')).resolves.toEqual(
      newTitles
    )
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(1)
  })
})
