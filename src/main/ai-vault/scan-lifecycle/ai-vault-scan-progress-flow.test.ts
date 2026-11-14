import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resetLocalAiVaultScanProgressForTests } from './ai-vault-local-scan-progress'
import * as parseCache from '../parse-cache/session-scanner-parse-cache'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { scanAiVaultSessions } from '../session-scanner'
import { resetSessionParseCacheForTests } from '../parse-cache/session-parse-cache-store'
import {
  isolatedScanRoots,
  writeJsonlFile
} from '../scanner-fixtures/session-scanner-test-fixtures'

// Source fixtures exercise the real SQLite readers without a packaged worker bundle.
vi.mock(
  '../scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const { listOpenCodeSqliteSessions } =
      await import('../scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const { listOpenCode2SqliteSessions } =
      await import('../scanners/opencode2/session-scanner-opencode2-sqlite-list')
    const { parseOpenCodeSqliteSession } =
      await import('../scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    return {
      listOpenCode2SqliteSessionsViaWorker: listOpenCode2SqliteSessions,
      listOpenCodeSqliteSessionsViaWorker: listOpenCodeSqliteSessions,
      listZcodeSqliteSessionsViaWorker: (args: Parameters<typeof listOpenCodeSqliteSessions>[0]) =>
        listOpenCodeSqliteSessions({ ...args, agent: 'zcode' }),
      parseOpenCodeSqliteSessionViaWorker: parseOpenCodeSqliteSession
    }
  }
)

let tempRoot: string | null = null

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  resetLocalAiVaultScanProgressForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

it('does not settle a batch interrupted during its real parser invocation', async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-abort-'))
  const roots = isolatedScanRoots(tempRoot)
  await writeJsonlFile(join(roots.claudeProjectsDir, 'project', 'a.jsonl'), [
    { type: 'user', sessionId: 'a', message: { role: 'user', content: 'Generated' } }
  ])
  const controller = new AbortController()
  const original = parseCache.parseListedSessionFile
  vi.spyOn(parseCache, 'parseListedSessionFile').mockImplementation(async (...args) => {
    const result = await original(...args)
    controller.abort()
    return result
  })
  const stop = trackAiVaultScanProgress(controller.signal, () => undefined)
  try {
    await expect(
      scanAiVaultSessions({ ...roots, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(aiVaultScanWork(controller.signal)?.read).toEqual({ done: 0, total: 1, skipped: 0 })
  } finally {
    stop()
  }
})
