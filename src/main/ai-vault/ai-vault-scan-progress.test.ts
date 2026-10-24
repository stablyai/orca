import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'
import {
  AI_VAULT_SCAN_PROGRESS_INTERVAL_MS,
  noteAiVaultScanFileFound,
  aiVaultScanWork,
  openAiVaultScanSource,
  noteAiVaultScanWorkChanged,
  trackAiVaultScanProgress
} from './ai-vault-scan-progress'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
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

function codexFile(index: number): { path: string; dev: number; ino: number } {
  return { path: `/sessions/${index}.jsonl`, dev: 1, ino: index + 1 }
}

describe('scan progress reporting', () => {
  it('reports at most once per interval, with the latest tally trailing', () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const files: number[] = []
    const stop = trackAiVaultScanProgress(
      signal,
      (work) => files.push(work.agents[0]?.files ?? 0),
      () => Date.now()
    )

    noteAiVaultScanFileFound(signal, 'codex', codexFile(0))
    noteAiVaultScanWorkChanged(signal)
    for (let index = 1; index < 16; index++) {
      noteAiVaultScanFileFound(signal, 'codex', codexFile(index))
      noteAiVaultScanWorkChanged(signal)
    }
    expect(files).toEqual([1])
    vi.advanceTimersByTime(AI_VAULT_SCAN_PROGRESS_INTERVAL_MS)
    expect(files).toEqual([1, 16])

    stop()
    noteAiVaultScanWorkChanged(signal)
    vi.advanceTimersByTime(AI_VAULT_SCAN_PROGRESS_INTERVAL_MS)
    expect(files).toEqual([1, 16])
  })

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

it('keeps source ownership and final facts independent of immediate and trailing sink faults', () => {
  vi.useFakeTimers()
  const signal = new AbortController().signal
  const sink = vi.fn(() => {
    throw new Error('Synthetic reporting sink fault')
  })
  const stop = trackAiVaultScanProgress(signal, sink, () => Date.now())
  const close = openAiVaultScanSource(signal, 'claude')
  expect(aiVaultScanWork(signal)?.agents[0]?.walking).toBe(true)
  close()
  expect(() => vi.advanceTimersByTime(AI_VAULT_SCAN_PROGRESS_INTERVAL_MS)).not.toThrow()
  expect(sink).toHaveBeenCalledTimes(2)
  expect(aiVaultScanWork(signal)?.agents).toEqual([])
  stop()
})
