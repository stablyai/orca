// Relay per-hunk diff/apply round-trip (diffPatch -> build -> applyPatch); split
// from git-handler-staging.test.ts to stay under the max-lines cap.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import { buildHunkPatch, parseFileDiff } from '../shared/git-hunk-patch'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

const ORIGINAL = `${Array.from({ length: 12 }, (_, i) => String(i + 1)).join('\n')}\n`
const MODIFIED = ORIGINAL.replace('2\n', '2x\n').replace('11\n', '11x\n')

function cachedDiff(repo: string): string {
  return execFileSync('git', ['diff', '--cached', '--', 'file.txt'], {
    cwd: repo,
    encoding: 'utf-8'
  })
}

describe('GitHandler — per-hunk staging', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-hunk-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
    gitInit(tmpDir)
    writeFileSync(path.join(tmpDir, 'file.txt'), ORIGINAL)
    gitCommit(tmpDir, 'initial')
    writeFileSync(path.join(tmpDir, 'file.txt'), MODIFIED)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the unified diff via git.diffPatch', async () => {
    const result = (await dispatcher.callRequest('git.diffPatch', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      staged: false
    })) as { patch: string }
    expect(result.patch).toContain('@@')
    expect(parseFileDiff(result.patch).hunks).toHaveLength(2)
  })

  it('stages a single hunk via git.applyPatch', async () => {
    const { patch } = (await dispatcher.callRequest('git.diffPatch', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      staged: false
    })) as { patch: string }
    const single = buildHunkPatch(parseFileDiff(patch), [0])

    await dispatcher.callRequest('git.applyPatch', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      patch: single,
      reverse: false
    })

    expect(cachedDiff(tmpDir)).toContain('+2x')
    expect(cachedDiff(tmpDir)).not.toContain('+11x')
  })

  it('unstages a single hunk via git.applyPatch with reverse', async () => {
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })
    const { patch } = (await dispatcher.callRequest('git.diffPatch', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      staged: true
    })) as { patch: string }
    const single = buildHunkPatch(parseFileDiff(patch), [1])

    await dispatcher.callRequest('git.applyPatch', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      patch: single,
      reverse: true
    })

    expect(cachedDiff(tmpDir)).toContain('+2x')
    expect(cachedDiff(tmpDir)).not.toContain('+11x')
  })

  it('rejects a path that escapes the worktree', async () => {
    await expect(
      dispatcher.callRequest('git.diffPatch', {
        worktreePath: tmpDir,
        filePath: '../escape.txt',
        staged: false
      })
    ).rejects.toThrow(/outside the worktree/)
  })
})
