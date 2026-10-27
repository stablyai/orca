import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import { parseSessionCandidates } from './session-scanner-candidate-parse'
import { createSessionParseStats } from './session-scanner-parse-cache'
import {
  resetSessionParseCacheForTests,
  storeSessionParseCacheEntry
} from './session-parse-cache-store'
import { createAccumulator, finalizeSession, sessionSortTime } from './session-scanner-accumulator'
import * as cutoff from './session-scan-cutoff'

const tempRoots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session scanner cutoff', () => {
  it('amortizes exhaustive copied-history ranking and keeps preferred aliases authoritative', async () => {
    let work = 0
    const original = cutoff.canStopParsingSessions
    vi.spyOn(cutoff, 'canStopParsingSessions').mockImplementation((rows, limit, next) => {
      if (rows.size >= limit) {
        work += rows.size
      }
      return original(rows, limit, next)
    })
    const scan = async (count: number, aliases = false) => {
      resetSessionParseCacheForTests()
      const candidates = Array.from({ length: count }, (_, index) => {
        const alias = aliases && (index === 0 || index === 8)
        const file = {
          path: `/${index}/rollout-${alias ? 'alias' : index}.jsonl`,
          mtimeMs: aliases && index >= 16 ? 95 : 10_000 - index,
          modifiedAt: new Date(10_000 - index).toISOString()
        }
        const session = finalizeSession(
          createAccumulator({
            agent: alias ? 'codex' : 'hermes',
            sessionId: alias ? 'alias' : `session-${index}`,
            file
          }),
          'linux'
        )
        if (!session) {
          throw new Error('Expected a cached session')
        }
        const activity = aliases
          ? index === 0
            ? 100
            : index === 8
              ? 10
              : index === 1
                ? 90
                : 1
          : index
        storeSessionParseCacheEntry(file.path, {
          platform: 'linux',
          mtimeMs: file.mtimeMs,
          sizeBytes: null,
          resume: null,
          session: {
            ...session,
            executionHostId: 'local',
            updatedAt: new Date(activity).toISOString(),
            codexHome: index === 0 ? '/custom' : null
          }
        })
        return { agent: session.agent, file, codexHome: null }
      })
      work = 0
      const rows = await parseSessionCandidates({
        candidates,
        limit: 1,
        platform: 'linux',
        executionHostId: 'local',
        issues: [],
        parseStats: createSessionParseStats(),
        listed: false,
        selectCandidate: async () => true
      })
      return { rows, work }
    }
    const small = await scan(256)
    const large = await scan(2560)
    expect(
      small.rows.toSorted((a, b) => sessionSortTime(b) - sessionSortTime(a))[0]?.sessionId
    ).toBe('session-255')
    expect(
      large.rows.toSorted((a, b) => sessionSortTime(b) - sessionSortTime(a))[0]?.sessionId
    ).toBe('session-2559')
    expect(large.work).toBeLessThan(2560 * 2)
    expect(large.work).toBeLessThan(small.work * 20)
    const aliases = await scan(40, true)
    expect(aliases.rows).toHaveLength(39)
    expect(aliases.rows.find((row) => row.sessionId === 'alias')?.updatedAt).toBe(
      new Date(10).toISOString()
    )
    expect(
      aliases.rows.toSorted((a, b) => sessionSortTime(b) - sessionSortTime(a))[0]?.sessionId
    ).toBe('session-1')
  })

  it('does not sort timestamps at every post-limit candidate', async () => {
    const count = 128
    const limit = count / 2
    const root = await mkdtemp(join(tmpdir(), 'orca-session-cutoff-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(roots.codexSessionsDir, { recursive: true })
    for (let index = 0; index < count; index++) {
      const name = `rollout-session-${index}.jsonl`
      const content = jsonLines([
        { type: 'session_meta', payload: { id: `session-${index}`, cwd: '/repo/folder' } },
        {
          type: 'event_msg',
          timestamp: new Date(index).toISOString(),
          payload: { type: 'user_message', message: 'Check this session' }
        }
      ])
      const mtime = 10_000 - index
      const filePath = join(roots.codexSessionsDir, name)
      await writeFile(filePath, content)
      await utimes(filePath, new Date(mtime), new Date(mtime))
    }
    let numericSorts = 0
    const originalSort = Array.prototype.sort
    vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
      if (typeof this[0] === 'number') {
        numericSorts++
      }
      return originalSort.call(this, compare)
    })
    const scan = () => scanAiVaultSessions({ ...roots, limit })

    for (let pass = 0; pass < 2; pass++) {
      numericSorts = 0
      const result = await scan()
      expect(result.issues).toEqual([])
      expect(result.sessions.map((row) => row.sessionId)).toEqual(
        Array.from({ length: limit }, (_, index) => `session-${count - index - 1}`)
      )
      expect(numericSorts).toBe(0)
    }
  })
})
