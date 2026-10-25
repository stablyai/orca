import { link, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanProgress, AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress,
  requestLocalAiVaultScan,
  resetLocalAiVaultScanProgressForTests,
  startLocalAiVaultScanProgress
} from './ai-vault-local-scan-progress'
import * as parseCache from './session-scanner-parse-cache'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { AiVaultScanTally } from './ai-vault-scan-tally'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

// Source fixtures exercise the real SQLite readers without a packaged worker bundle.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const { listOpenCodeSqliteSessions } = await import('./session-scanner-opencode-sqlite-list')
  const { listOpenCode2SqliteSessions } = await import('./session-scanner-opencode2-sqlite-list')
  const { parseOpenCodeSqliteSession } = await import('./session-scanner-opencode-sqlite')
  return {
    listOpenCode2SqliteSessionsViaWorker: listOpenCode2SqliteSessions,
    listOpenCodeSqliteSessionsViaWorker: listOpenCodeSqliteSessions,
    listZcodeSqliteSessionsViaWorker: (args: Parameters<typeof listOpenCodeSqliteSessions>[0]) =>
      listOpenCodeSqliteSessions({ ...args, agent: 'zcode' }),
    parseOpenCodeSqliteSessionViaWorker: parseOpenCodeSqliteSession
  }
})

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

async function scanInChild(
  limit = 20
): Promise<{ reports: AiVaultScanWork[]; final: AiVaultScanWork }> {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-strip-'))
  const roots = isolatedScanRoots(tempRoot)
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const path = join(roots.claudeProjectsDir, 'project', `${name}.jsonl`)
    await writeJsonlFile(path, [
      {
        type: 'user',
        sessionId: name,
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: `ask ${name}` }
      }
    ])
    await utimes(path, 1_000 + index, 1_000 + index)
  }
  // Codex homes and linked profiles can expose hardlinks to the same transcript.
  await mkdir(join(roots.claudeProjectsDir, 'linked'))
  await link(
    join(roots.claudeProjectsDir, 'project', 'a.jsonl'),
    join(roots.claudeProjectsDir, 'linked', 'a.jsonl')
  )
  const signal = new AbortController().signal
  const reports: AiVaultScanWork[] = []
  let now = 0
  trackAiVaultScanProgress(
    signal,
    (work) => reports.push(work),
    () => (now += 1_000)
  )
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit, signal })
  return { reports, final: aiVaultScanWork(signal)! }
}

function startScan(): {
  child: AiVaultServiceTestChild
  client: AiVaultScannerServiceClient
  scan: Promise<{ work: AiVaultScanWork | null }>
  published: (AiVaultScanProgress | null)[]
} {
  const child = new AiVaultServiceTestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChildProcess(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const published: (AiVaultScanProgress | null)[] = []
  onLocalAiVaultScanProgress(({ progress }) => published.push(progress))
  const scan = requestLocalAiVaultScan(
    (listener) =>
      client.request<{ work: AiVaultScanWork | null }>(
        { type: 'request', operation: 'scan', options: {} },
        undefined,
        listener
      ),
    { now: () => 5_000 }
  )
  return { child, client, scan, published }
}

describe('Session History scan progress, scanner child to window', () => {
  it('counts distinct files while walking, then reads, and publishes the finished totals', async () => {
    const { reports, final } = await scanInChild()
    expect(reports.some((work) => work.stage === 'finding')).toBe(true)
    expect(final).toEqual({
      stage: 'reading',
      agents: [
        {
          agent: 'claude',
          files: 3,
          databases: 0,
          walking: false,
          read: { done: 4, total: 4, skipped: 0 }
        }
      ],
      read: { done: 4, total: 4, skipped: 0 }
    })

    const { child, scan, published } = startScan()
    readyAiVaultServiceChild(child)
    await vi.waitFor(() => expect(localAiVaultScanProgress('')?.stage).toBe('finding'))
    const id = aiVaultServiceRequestId(child, 'scan')
    child.emit('message', { type: 'progress', id, work: reports[0] })
    child.emit('message', {
      type: 'result',
      id,
      operation: 'scan',
      value: { result: { sessions: [], issues: [], scannedAt: '' }, durationMs: 1, work: final }
    })
    await scan

    expect(published.map((progress) => progress?.stage ?? null)).toEqual([
      'finding',
      reports[0]!.stage,
      'finished'
    ])
    expect(localAiVaultScanProgress('')).toEqual({
      ...final,
      scanId: '',
      stage: 'finished',
      startedAt: 5_000,
      settledAt: 5_000
    })
  })

  it('reaches its total when the first pass stops before reading every file it planned', async () => {
    const { reports, final } = await scanInChild(1)
    expect(final.read).toEqual({ done: 1, total: 2, skipped: 1 })
    expect(
      reports.filter((work) => work.stage === 'reading').every((work) => work.read.total === 2)
    ).toBe(true)
  })

  it('keeps a replacement entry when the scan it replaced fails late', () => {
    const earlier = startLocalAiVaultScanProgress('scope', 'earlier', () => 500)
    earlier.finish(null)
    const old = startLocalAiVaultScanProgress('scope', 'old', () => 1_000)
    const replacement = startLocalAiVaultScanProgress('scope', 'replacement', () => 2_000)
    old.fail()
    expect(localAiVaultScanProgress('scope')).toMatchObject({ stage: 'finding', startedAt: 2_000 })

    replacement.fail()
    expect(localAiVaultScanProgress('scope')).toMatchObject({
      scanId: 'earlier',
      stage: 'finished'
    })
  })

  it('settles unfinished work when an interactive timeout retires the shared scanner', async () => {
    vi.useFakeTimers()
    const { child, client, scan } = startScan()
    const rejectedScan = scan.catch((error: Error) => error)
    const interactive = client.request({
      type: 'request',
      operation: 'subagents',
      request: { agent: 'claude', parentFilePath: '/tmp/parent.jsonl' }
    })
    const rejectedInteractive = interactive.catch((error: Error) => error)
    readyAiVaultServiceChild(child)
    await vi.advanceTimersByTimeAsync(0)
    child.emit('message', {
      type: 'progress',
      id: aiVaultServiceRequestId(child, 'scan'),
      work: { stage: 'finding', agents: [], read: { done: 0, total: 0 } }
    })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await rejectedInteractive).toBeInstanceOf(Error)
    expect(await rejectedScan).toBeInstanceOf(Error)
    expect(localAiVaultScanProgress('')).toMatchObject({ stage: 'finding', settledAt: 5_000 })
    const retry = startLocalAiVaultScanProgress('', 'retry', () => 6_000)
    retry.work({ stage: 'reading', agents: [], read: { done: 1, total: 2 } })
    retry.fail()
    expect(localAiVaultScanProgress('')).toMatchObject({
      scanId: 'retry',
      stage: 'reading',
      settledAt: 6_000,
      read: { done: 1, total: 2 }
    })
    client.dispose()
  })

  it('counts inode aliases within a namespace but keeps distinct WSL distros', () => {
    const tally = new AiVaultScanTally()
    for (const path of [
      '\\\\wsl$\\Ubuntu\\home\\a\\one.jsonl',
      '\\\\wsl.localhost\\ubuntu\\home\\a\\alias.jsonl',
      '\\\\wsl$\\Debian\\home\\a\\other.jsonl',
      'C:\\Users\\a\\native.jsonl'
    ]) {
      tally.addFile('codex', { path, dev: 1, ino: 100 })
    }
    expect(tally.snapshot().agents).toMatchObject([{ agent: 'codex', files: 3 }])
  })
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
      } finally {
        stop()
      }
      listed.mockClear()
      walked.mockClear()
      opened.mockClear()
    }
  }
)

it.each([false, true])(
  'counts repeated global visits and database sessions once (scoped=%s)',
  async (scoped) => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-repeat-'))
    const roots = isolatedScanRoots(tempRoot)
    await writeJsonlFile(join(roots.droidSessionsDir, 'same.jsonl'), [
      { type: 'session_start', id: 'same', cwd: '/repo', timestamp: '2026-10-19T00:00:00Z' },
      { type: 'message', message: { role: 'user', content: 'Generated' } }
    ])
    const database = join(tempRoot, 'opencode.db')
    writeOpenCodeSqliteDatabase(database, [
      { id: 'db-session', directory: '/repo', turns: [{ role: 'user', parts: ['Generated'] }] }
    ])
    const listed = vi.spyOn(parseCache, 'parseListedSessionFile')
    const signal = new AbortController().signal
    const reports: AiVaultScanWork[] = []
    let pendingAfterParses = false
    let now = 0
    const stop = trackAiVaultScanProgress(
      signal,
      (work) => {
        reports.push(work)
        if (listed.mock.calls.length === 3 && work.stage === 'reading' && work.read.done === 0) {
          pendingAfterParses = true
        }
      },
      () => (now += 1000)
    )
    try {
      const result = await scanAiVaultSessions({
        ...roots,
        droidProjectsDir: roots.droidSessionsDir,
        opencodeDbPaths: [database],
        scopePaths: scoped ? ['/repo'] : [],
        signal,
        limit: 20,
        platform: 'darwin'
      })
      expect(result.sessions.map((row) => row.sessionId).sort()).toEqual(
        scoped ? ['db-session', 'same'] : ['db-session', 'same', 'same']
      )
      expect(listed.mock.calls.filter(([candidate]) => candidate.agent === 'droid')).toHaveLength(2)
      expect(aiVaultScanWork(signal)?.read).toEqual({ done: 2, total: 2, skipped: 0 })
      if (scoped) {
        expect(pendingAfterParses).toBe(true)
      }
      expect(
        reports.filter((work) => work.stage === 'reading').every((work) => work.read.total === 2)
      ).toBe(true)
      expect(
        aiVaultScanWork(signal)?.agents.find((agent) => agent.agent === 'opencode')?.read
      ).toEqual({ done: 1, total: 1, skipped: 0 })
    } finally {
      stop()
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
