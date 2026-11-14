import * as fs from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './scanner-fixtures/session-scanner-test-fixtures'
import { resetSessionParseCacheForTests } from './parse-cache/session-parse-cache-store'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './parse-cache/session-parse-cache-persistence'
import * as readers from './transcripts/session-transcript-reader'

vi.mock('node:fs/promises', { spy: true })
vi.mock('node:fs', { spy: true })
const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  for (const path of temporary.splice(0)) {
    await fs.rm(path, { recursive: true, force: true })
  }
})
function codex(id: string, cwd = '/repo/one') {
  return [
    { type: 'session_meta', payload: { id, cwd } },
    {
      type: 'event_msg',
      timestamp: '2026-11-13T12:00:00.000Z',
      payload: { type: 'user_message', message: id }
    }
  ]
}

it.each([10, 100])(
  'bounds unchanged list work to one physical stat and no transcript reads at N=%i, including scoped copy proof',
  async (count) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'orca-list-reuse-'))
    temporary.push(root)
    const roots = isolatedScanRoots(root)
    const mirror = join(root, 'mirror', 'sessions')
    const transcripts = new Set<string>()
    for (let index = 0; index < count; index++) {
      const name = `rollout-legacy-${index}.jsonl`
      for (const directory of [roots.codexSessionsDir, mirror]) {
        const path = join(directory, name)
        transcripts.add(path)
        await writeJsonlFile(path, codex(`id-${index}`))
      }
      const path = join(roots.piSessionsDir, '--repo-one--', `pi-${index}.jsonl`)
      transcripts.add(path)
      await writeJsonlFile(path, [
        {
          type: 'session',
          version: 3,
          id: `pi-${index}`,
          cwd: '/repo/one',
          timestamp: '2026-11-13T12:00:00.000Z'
        },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }
      ])
    }
    const options = {
      ...roots,
      additionalCodexSessionsDirs: [mirror],
      unlimited: true,
      scopePaths: ['/repo/one'],
      scopeOnly: true
    }
    const first = await scanAiVaultSessions(options)
    expect(first.sessions.length).toBeGreaterThanOrEqual(count)
    vi.mocked(fs.stat).mockClear()
    vi.mocked(nodeFs.createReadStream).mockClear()
    vi.mocked(fs.readFile).mockClear()
    const full = vi.spyOn(readers, 'readWholeTranscript')
    const fold = vi.spyOn(readers, 'readResumableTranscript')
    const warm = await scanAiVaultSessions(options)
    expect(warm.sessions).toEqual(first.sessions)
    const observed = vi
      .mocked(fs.stat)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => transcripts.has(path))
    expect(observed.length).toBeLessThanOrEqual(transcripts.size)
    expect(new Set(observed).size).toBe(observed.length)
    expect(
      vi
        .mocked(nodeFs.createReadStream)
        .mock.calls.filter(([path]) => transcripts.has(String(path)))
    ).toEqual([])
    expect(
      vi.mocked(fs.readFile).mock.calls.filter(([path]) => transcripts.has(String(path)))
    ).toEqual([])
    expect(full).not.toHaveBeenCalled()
    expect(fold).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'invalidates an equal-length preserved-mtime replacement (restart=%s), then reuses it unchanged',
  async (restart) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'orca-list-replacement-'))
    temporary.push(root)
    const roots = isolatedScanRoots(root)
    const path = join(roots.codexSessionsDir, 'rollout-legacy.jsonl')
    const cache = { filePath: join(root, 'cache', 'parse.json'), appVersion: 'test' }
    await writeJsonlFile(path, codex('before'))
    const before = await fs.stat(path)
    initSessionParseCachePersistence(cache)
    const first = await scanAiVaultSessions({ ...roots, unlimited: true })
    expect(first.sessions[0]?.sessionId).toBe('before')
    await flushSessionParseCachePersist()
    if (restart) {
      resetSessionParseCachePersistenceForTests()
      resetSessionParseCacheForTests()
    }
    const replacement = join(root, 'replacement.jsonl')
    await writeJsonlFile(replacement, codex('after!'))
    expect((await fs.stat(replacement)).size).toBe(before.size)
    await fs.utimes(replacement, before.atime, before.mtime)
    await fs.rename(replacement, path)
    if (restart) {
      initSessionParseCachePersistence(cache)
    }
    const changed = await scanAiVaultSessions({ ...roots, unlimited: true })
    expect(changed.sessions[0]?.sessionId).toBe('after!')
    const read = vi.spyOn(readers, 'readResumableTranscript')
    await scanAiVaultSessions({ ...roots, unlimited: true })
    expect(read).not.toHaveBeenCalled()
  }
)
