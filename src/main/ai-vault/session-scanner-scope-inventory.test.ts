import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-error'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { recordSessionScanIssue } from './session-scan-issues'
import { CLAUDE_CWD_BUCKET_LAYOUT, PI_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'
import { inventoryCwdBucketFiles, selectCwdBucketFiles } from './session-scanner-scope-inventory'
import { writeJsonlFile } from './session-scanner-test-fixtures'
let root: string | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('replays tied selection, winner exclusion and evicted paths in original root order', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bucket-replay-'))
  const paths = ['b', 'a', 'c', 'winner'].map((name) => join(root!, '--repo--', `${name}.jsonl`))
  for (const [index, path] of paths.entries()) {
    await writeJsonlFile(path, [{ type: 'session', cwd: '/repo' }])
    await utimes(path, index < 2 ? 1 : 2, index < 2 ? 1 : 2)
  }
  const read = transcriptFs.wslGatedReaddir
  vi.spyOn(transcriptFs, 'wslGatedReaddir').mockImplementation(async (path, ...args) =>
    (await read(path, ...args)).sort(
      (left, right) => paths.indexOf(join(path, left.name)) - paths.indexOf(join(path, right.name))
    )
  )
  const opened = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
  const inventory = await inventoryCwdBucketFiles(PI_CWD_BUCKET_LAYOUT, {
    rootDirs: [root, root],
    scopePaths: ['/repo'],
    limit: 1
  })
  expect(opened).not.toHaveBeenCalled()
  const selected = await selectCwdBucketFiles(inventory, {
    scopePaths: ['/repo'],
    limit: 1,
    excludedFilePaths: new Set([paths[3]]),
    issues: []
  })
  expect(selected.map((file) => file.path)).toEqual([paths[2]])
  expect(opened.mock.calls.map(([path]) => path)).toEqual([
    paths[0],
    paths[1],
    paths[2],
    paths[0],
    paths[1]
  ])
})

it('replays staged errors after global errors, interleaved with bucket errors under the issue cap', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bucket-issues-'))
  const path = join(root, '--repo--', 'a.jsonl')
  await writeJsonlFile(path, [{ type: 'session', cwd: '/repo' }])
  const read = transcriptFs.wslGatedReaddir
  const refused = join(root, 'refused')
  vi.spyOn(transcriptFs, 'wslGatedReaddir').mockImplementation((path, ...args) => {
    if (path === refused) {
      throw new WslTranscriptFsError('unavailable', 'Generated root failure')
    }
    return read(path, ...args)
  })
  const inventory = await inventoryCwdBucketFiles(PI_CWD_BUCKET_LAYOUT, {
    rootDirs: [root, refused],
    scopePaths: ['/repo'],
    limit: 1
  })
  vi.spyOn(transcriptFs, 'wslGatedStat').mockRejectedValue(new Error('Generated stat failure'))
  const issues: AiVaultScanIssue[] = []
  for (let index = 0; index < 498; index++) {
    recordSessionScanIssue(issues, {
      agent: 'codex',
      path: String(index),
      message: 'Generated global failure'
    })
  }
  const expected = [...issues]
  recordSessionScanIssue(expected, { agent: 'pi', path, message: 'Generated stat failure' })
  recordSessionScanIssue(expected, {
    agent: 'pi',
    path: refused,
    message: 'Generated root failure'
  })
  await selectCwdBucketFiles(inventory, {
    scopePaths: ['/repo'],
    limit: 1,
    excludedFilePaths: new Set(),
    issues
  })
  expect(issues).toEqual(expected)
  expect(issues.at(-1)).toMatchObject({ kind: 'notice' })
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
