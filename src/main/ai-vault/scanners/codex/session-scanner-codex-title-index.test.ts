import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as transcriptFs from '../../../native-chat/wsl-transcript-fs-access'
import { readCodexIndexUpdate } from './session-scanner-codex-index-read'
import { parseAgentSessionFileCached } from '../../parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _getCodexSessionIndexTitleCacheSizeForTest,
  _readCachedCodexSessionIndexTitlesForTest,
  _storeCodexSessionIndexTitleCacheEntryForTest,
  resetCodexSessionIndexTitleCacheForTests
} from './session-scanner-codex-title-index'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('codex session index title cache', () => {
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

    await expect(pendingOldHit).resolves.toBe(resolvedOldTitles)
    await expect(_readCachedCodexSessionIndexTitlesForTest('same-home', 'new')).resolves.toBe(
      newTitles
    )
    expect(_getCodexSessionIndexTitleCacheSizeForTest()).toBe(1)
  })
})

async function indexHome() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-index-'))
  tempRoots.push(root)
  return { root, path: join(root, 'session_index.jsonl') }
}
const entry = (id: string, thread_name: string) => `${JSON.stringify({ id, thread_name })}\n`

describe('incremental Codex session names', () => {
  it('applies only appended complete records and retains a partial tail for the next read', async () => {
    const { path } = await indexHome()
    const initial = entry('session', 'First')
    await writeFile(path, initial)
    const first = await readCodexIndexUpdate(path, await stat(path))
    const stream = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
    await appendFile(path, `${entry('session', 'Renamed')}{"id":"session","thread_name":"Final"}`)
    const next = await readCodexIndexUpdate(path, await stat(path), first)
    expect(next.titles.get('session')).toBe('Renamed')
    expect(
      stream.mock.calls.some(([, options]) => options.start === Buffer.byteLength(initial))
    ).toBe(true)
    await appendFile(path, '\n')
    expect((await readCodexIndexUpdate(path, await stat(path), next)).titles.get('session')).toBe(
      'Final'
    )
  })

  it('rebuilds on replacement, a growing rewrite, and shrink instead of retaining removed names', async () => {
    const { path } = await indexHome()
    const head = entry('head', 'Unchanged head')
    await writeFile(path, head + entry('removed', 'Gone'))
    let cached = await readCodexIndexUpdate(path, await stat(path))
    await writeFile(`${path}.replacement`, head + entry('retained', 'A longer replacement title'))
    await rename(`${path}.replacement`, path)
    cached = await readCodexIndexUpdate(path, await stat(path), cached)
    expect([...cached.titles.keys()]).toEqual(['head', 'retained'])
    await writeFile(
      path,
      entry('rewritten', 'A completely rewritten and substantially longer first record than before')
    )
    cached = await readCodexIndexUpdate(path, await stat(path), cached)
    expect([...cached.titles.keys()]).toEqual(['rewritten'])
    await writeFile(path, entry('short', 'Short'))
    cached = await readCodexIndexUpdate(path, await stat(path), cached)
    expect([...cached.titles]).toEqual([['short', 'Short']])
  })

  it('keeps the indexed rename over a recorded session_meta title when the rollout grows', async () => {
    const { root, path } = await indexHome()
    const rollout = join(root, 'sessions', 'rollout.jsonl')
    await mkdir(join(root, 'sessions'))
    // Recorded CLI session_meta shape; private instructions omitted and paths/identity anonymized.
    const meta = {
      timestamp: '2026-11-05T16:21:02.828Z',
      type: 'session_meta',
      payload: {
        id: 'recorded-session',
        timestamp: '2026-11-05T16:21:02.674Z',
        cwd: '/repo/app',
        originator: 'codex_exec',
        cli_version: '0.162.1',
        source: 'exec',
        model_provider: 'codex-lb',
        title: 'Original metadata name'
      }
    }
    await writeFile(rollout, `${JSON.stringify(meta)}\n`)
    const read = async () => {
      const stats = await stat(rollout)
      return parseAgentSessionFileCached(
        {
          agent: 'codex',
          codexHome: root,
          file: {
            path: rollout,
            mtimeMs: stats.mtimeMs,
            modifiedAt: stats.mtime.toISOString(),
            sizeBytes: stats.size
          }
        },
        'darwin'
      )
    }
    expect((await read())?.title).toBe('Original metadata name')
    await writeFile(path, entry('recorded-session', 'Renamed in the index'))
    expect((await read())?.title).toBe('Renamed in the index')
    await appendFile(
      rollout,
      `${JSON.stringify({
        timestamp: '2026-11-05T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Continue working' }
      })}\n`
    )
    expect((await read())?.title).toBe('Renamed in the index')
  })
})
