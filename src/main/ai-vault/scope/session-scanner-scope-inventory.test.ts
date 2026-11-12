import { mkdtemp, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import * as transcriptFs from '../../native-chat/wsl-transcript-fs-access'

import { aiVaultScanWork, trackAiVaultScanProgress } from '../scan-lifecycle/ai-vault-scan-progress'

import { CLAUDE_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'
import { inventoryCwdBucketFiles } from './session-scanner-scope-inventory'
import { writeJsonlFile } from '../scanner-fixtures/session-scanner-test-fixtures'
let root: string | null = null
afterEach(async () => {
  vi.restoreAllMocks()
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
