import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const tempRoots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session scan batch deduplication', () => {
  it('does not rederive every retained rollout alias after each batch', async () => {
    const count = 128
    const root = await mkdtemp(join(tmpdir(), 'orca-session-dedup-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(roots.codexSessionsDir, { recursive: true })
    for (let index = 0; index < count; index++) {
      const name = `rollout-session-${index}.jsonl`
      const content = jsonLines([
        { type: 'session_meta', payload: { id: `session-${index}`, cwd: '/repo/folder' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Check this session' } }
      ])
      await writeFile(join(roots.codexSessionsDir, name), content)
    }
    let aliasChecks = 0
    const originalTest = RegExp.prototype.test
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value) {
      if (this.source === '^rollout-.+\\.jsonl$') {
        aliasChecks++
      }
      return originalTest.call(this, value)
    })
    const scan = () => scanAiVaultSessions({ ...roots, unlimited: true })

    for (let pass = 0; pass < 2; pass++) {
      aliasChecks = 0
      const result = await scan()
      expect(result.issues).toEqual([])
      expect(result.sessions).toHaveLength(count)
      expect(new Set(result.sessions.map((session) => session.sessionId)).size).toBe(count)
      expect(aliasChecks).toBeLessThanOrEqual(count * 8)
    }
  })
})
