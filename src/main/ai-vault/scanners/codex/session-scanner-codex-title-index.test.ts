import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexIndexUpdate } from './session-scanner-codex-index-read'
import { parseAgentSessionFileCached } from '../../parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCodexSessionIndexTitleCacheForTests } from './session-scanner-codex-title-index'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function indexHome() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-index-'))
  tempRoots.push(root)
  return { root, path: join(root, 'session_index.jsonl') }
}
const entry = (id: string, thread_name: string) => `${JSON.stringify({ id, thread_name })}\n`

describe('incremental Codex session names', () => {
  it('rereads an EOF title observed after stat when growth invalidates its record', async () => {
    const { path } = await indexHome()
    await writeFile(path, entry('head', 'Head') + entry('tail', 'Original'))
    const beforeAppend = await stat(path)
    await appendFile(path, entry('tail', 'EOF name').trimEnd())
    const first = await readCodexIndexUpdate(path, beforeAppend)
    expect([...first.titles]).toEqual([
      ['head', 'Head'],
      ['tail', 'EOF name']
    ])
    await appendFile(path, `invalid\n${entry('new', 'New name')}`)
    const next = await readCodexIndexUpdate(path, await stat(path), first)
    expect([...next.titles]).toEqual([
      ['head', 'Head'],
      ['tail', 'Original'],
      ['new', 'New name']
    ])
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

  it.each(['dev', 'ino'] as const)(
    'rereads an A,B index replaced by A,C,D when %s is unavailable',
    async (missing) => {
      const { path } = await indexHome()
      await writeFile(path, entry('A', 'Title A') + entry('B', 'Title B'))
      const first = await readCodexIndexUpdate(
        path,
        Object.assign(await stat(path), { [missing]: 0 })
      )
      await writeFile(
        `${path}.replacement`,
        entry('A', 'Title A') + entry('C', 'Title C') + entry('D', 'Title D')
      )
      await rename(`${path}.replacement`, path)
      const next = await readCodexIndexUpdate(
        path,
        Object.assign(await stat(path), { [missing]: 0 }),
        first
      )
      expect([...next.titles]).toEqual([
        ['A', 'Title A'],
        ['C', 'Title C'],
        ['D', 'Title D']
      ])
    }
  )

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
