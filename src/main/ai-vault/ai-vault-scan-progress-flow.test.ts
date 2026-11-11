import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanWork } from '../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { resetLocalAiVaultScanProgressForTests } from './ai-vault-local-scan-progress'
import * as parseCache from './parse-cache/session-scanner-parse-cache'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './parse-cache/session-parse-cache-store'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

// Source fixtures exercise the real SQLite readers without a packaged worker bundle.
vi.mock(
  './scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const { listOpenCodeSqliteSessions } =
      await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const { listOpenCode2SqliteSessions } =
      await import('./scanners/opencode2/session-scanner-opencode2-sqlite-list')
    const { parseOpenCodeSqliteSession } =
      await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite')
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

it.each(['cutoff', 'bucket', 'filtered'] as const)(
  'freezes %s work without changing cold/warm execution',
  async (flow) => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-frozen-'))
    const roots = isolatedScanRoots(tempRoot)
    for (let index = 0; index < (flow === 'filtered' ? 27 : 6); index++) {
      const timestamp = new Date(Date.UTC(2026, 9, 19) - index * 60_000).toISOString()
      const cwd =
        index >= 3 && (flow === 'bucket' || (index - 3) % 8 === 0) ? '/repo' : '/elsewhere'
      const path =
        flow === 'filtered'
          ? join(roots.codexSessionsDir, `rollout-${index}.jsonl`)
          : join(
              roots.claudeProjectsDir,
              cwd === '/repo' ? '-repo' : '-elsewhere',
              `${index}.jsonl`
            )
      await writeJsonlFile(
        path,
        flow === 'filtered'
          ? [
              { timestamp, type: 'session_meta', payload: { id: `fixture-${index}`, cwd } },
              {
                timestamp,
                type: 'event_msg',
                payload: { type: 'user_message', message: `Generated ${index}` }
              }
            ]
          : [
              {
                type: 'user',
                sessionId: `fixture-${index}`,
                timestamp,
                cwd,
                message: { role: 'user', content: `Generated ${index}` }
              }
            ]
      )
      await utimes(path, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000)
    }
    const listed = vi.spyOn(parseCache, 'parseListedSessionFile')
    const walked = vi.spyOn(parseCache, 'parseAgentSessionFileCached')
    const stats = vi.spyOn(parseCache, 'createSessionParseStats')
    const opened = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
    const ids =
      flow === 'cutoff'
        ? [0, 1, 2]
        : flow === 'filtered'
          ? [0, 1, 2, 3, 11, 19]
          : [0, 1, 2, 3, 4, 5]
    for (const warm of [false, true]) {
      const reports: AiVaultScanWork[] = []
      const signal = new AbortController().signal
      let now = 0
      const stop = trackAiVaultScanProgress(
        signal,
        (work) => reports.push(work),
        () => (now += 1000)
      )
      try {
        const result = await scanAiVaultSessions({
          ...roots,
          platform: 'darwin',
          limit: 3,
          limitPerAgent: 50,
          signal,
          ...(flow === 'cutoff' ? {} : { scopePaths: ['/repo'] })
        })
        expect(result.issues).toEqual([])
        expect(result.sessions.map((row) => row.sessionId)).toEqual(
          ids.map((id) => `fixture-${id}`)
        )
        const attempts = [...listed.mock.calls, ...walked.mock.calls].map(
          ([candidate]) => candidate.file.path
        )
        expect(
          attempts.map((path) =>
            Number(basename(path).replace('rollout-', '').replace('.jsonl', ''))
          )
        ).toEqual(ids)
        expect(opened.mock.calls).toHaveLength(warm ? 0 : flow === 'bucket' ? 7 : ids.length)
        expect(stats.mock.results.at(-1)?.value).toEqual({
          reused: warm ? ids.length : 0,
          incremental: 0,
          fullParses: warm ? 0 : ids.length,
          earlyStopped: 0,
          bytesRead: warm ? 0 : flow === 'filtered' ? 1363 : flow === 'bucket' ? 873 : 444
        })
        const reading = reports.filter((work) => work.stage === 'reading')
        const total = flow === 'filtered' ? 27 : 6
        let settled = 0
        for (const work of reading) {
          expect(work.read.total).toBe(total)
          expect(work.read.done + (work.read.skipped ?? 0)).toBeGreaterThanOrEqual(settled)
          settled = work.read.done + (work.read.skipped ?? 0)
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.total ?? 0), 0)).toBe(total)
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.done ?? 0), 0)).toBe(
            work.read.done
          )
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.skipped ?? 0), 0)).toBe(
            work.read.skipped
          )
        }
        expect(aiVaultScanWork(signal)?.read).toEqual({
          done: ids.length,
          total,
          skipped: total - ids.length
        })
        // Windows hide a rescan the parse cache fully answers.
        expect((aiVaultScanWork(signal)?.contentReads ?? 0) > 0).toBe(!warm)
      } finally {
        stop()
      }
      listed.mockClear()
      walked.mockClear()
      opened.mockClear()
    }
  }
)

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
