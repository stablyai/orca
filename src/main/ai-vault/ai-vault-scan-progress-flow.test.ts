import { link, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanProgress, AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress,
  requestLocalAiVaultScan,
  resetLocalAiVaultScanProgressForTests,
  startLocalAiVaultScanProgress
} from './ai-vault-local-scan-progress'
import { AiVaultScanTally } from './ai-vault-scan-tally'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoot: string | null = null

afterEach(async () => {
  vi.useRealTimers()
  resetSessionParseCacheForTests()
  resetLocalAiVaultScanProgressForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

/** Runs a real scan in this process the way the scanner child does, keeping every report. */
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
  // A second path to one transcript, as Codex homes and linked profiles produce: still one file.
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
      agents: [{ agent: 'claude', files: 3, databases: 0, walking: false }],
      read: { done: 4, total: 4 }
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
    // The newest file fills a limit of 1, so the pass never reads the older ones it announced.
    const { final } = await scanInChild(1)
    expect(final.read).toEqual({ done: 1, total: 1 })
  })

  it('keeps a replacement entry when the scan it replaced fails late', () => {
    const earlier = startLocalAiVaultScanProgress('scope', 'earlier', () => 500)
    earlier.finish(null)
    const old = startLocalAiVaultScanProgress('scope', 'old', () => 1_000)
    const replacement = startLocalAiVaultScanProgress('scope', 'replacement', () => 2_000)
    old.fail()
    expect(localAiVaultScanProgress('scope')).toMatchObject({ stage: 'finding', startedAt: 2_000 })

    // A failed refresh puts back the last finished scan rather than leaving the key empty.
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
