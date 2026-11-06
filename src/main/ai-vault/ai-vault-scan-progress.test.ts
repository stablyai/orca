import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanWork } from '../../shared/ai-vault/scanning/ai-vault-scan-progress'
import {
  AI_VAULT_SCAN_PROGRESS_INTERVAL_MS,
  trackAiVaultScanProgress
} from './ai-vault-scan-progress'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './parse-cache/session-parse-cache-store'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-scan-progress-'))
  tempRoots.push(root)
  return root
}

describe('scan progress reporting', () => {
  it('reports discovery and reading for its own scan, never for an unrelated one', async () => {
    const root = await tempRoot()
    const roots = isolatedScanRoots(root)
    for (const name of ['a', 'b', 'c']) {
      await writeJsonlFile(join(roots.claudeProjectsDir, 'project', `${name}.jsonl`), [
        {
          type: 'user',
          sessionId: name,
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/tmp/claude',
          message: { role: 'user', content: `ask ${name}` }
        }
      ])
    }
    const reports: AiVaultScanWork[] = []
    const tracked = new AbortController()
    let now = 0
    trackAiVaultScanProgress(
      tracked.signal,
      (work) => reports.push(work),
      () => (now += AI_VAULT_SCAN_PROGRESS_INTERVAL_MS)
    )

    await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20,
      signal: new AbortController().signal
    })
    expect(reports).toEqual([])

    resetSessionParseCacheForTests()
    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20,
      signal: tracked.signal
    })
    expect(result.sessions).toHaveLength(3)
    expect(reports.some((work) => work.stage === 'finding')).toBe(true)
    expect(reports.at(-1)).toMatchObject({ stage: 'reading', read: { done: 3, total: 3 } })
  })
})
