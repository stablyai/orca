import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import * as transcriptFs from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'

import { aiVaultScanWork, trackAiVaultScanProgress } from '../scan-lifecycle/ai-vault-scan-progress'

import { CLAUDE_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'
import {
  cachedProjectDirCwd,
  resetProjectDirCwdCacheForTests
} from './session-scanner-scope-discovery'
import type { AiVaultScanIssue } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { inventoryCwdBucketFiles } from './session-scanner-scope-inventory'
import { writeJsonlFile } from '../scanner-fixtures/session-scanner-test-fixtures'
let root: string | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  resetProjectDirCwdCacheForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('closes representative streams and inventory sources on cancellation before reading', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bucket-abort-'))
  await writeJsonlFile(join(root, '-repo', 'a.jsonl'), [{ cwd: '/repo' }])
  const controller = new AbortController()
  const input = new PassThrough()
  vi.spyOn(transcriptFs, 'openTranscriptReadStream').mockImplementation(() => {
    controller.abort()
    return input
  })
  const stop = trackAiVaultScanProgress(controller.signal, () => undefined)
  try {
    await expect(
      inventoryCwdBucketFiles(CLAUDE_CWD_BUCKET_LAYOUT, {
        rootDirs: [root],
        scopePaths: ['/repo'],
        limit: 1,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(input.destroyed).toBe(true)
    expect(aiVaultScanWork(controller.signal)).toMatchObject({
      stage: 'finding',
      agents: [],
      read: { done: 0, total: 0 }
    })
  } finally {
    stop()
  }
})

it('continues cold representative lookup after a post-enumeration stat refusal', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bucket-refusal-'))
  const bad = join(root, 'newest.jsonl')
  const healthy = join(root, 'healthy.jsonl')
  await writeJsonlFile(bad, [{ cwd: '/missing' }])
  await writeJsonlFile(healthy, [{ cwd: '/healthy' }])
  await utimes(bad, 2000, 2000)
  await utimes(healthy, 1000, 1000)
  const stat = transcriptFs.wslGatedStat
  let observed = false
  vi.spyOn(transcriptFs, 'wslGatedStat').mockImplementation((path, priority, signal) => {
    if (path === bad) {
      if (observed) {
        return Promise.reject(Object.assign(new Error('refused'), { code: 'EACCES' }))
      }
      observed = true
    }
    return stat(path, priority, signal)
  })
  const issues: AiVaultScanIssue[] = []
  await expect(cachedProjectDirCwd(root, (issue) => issues.push(issue), 'claude')).resolves.toBe(
    '/healthy'
  )
  expect(issues).toHaveLength(1)
  expect(issues[0]?.path).toBe(bad)
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    cachedProjectDirCwd(join(root, 'uncached'), () => undefined, 'claude', cancelled.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
})
