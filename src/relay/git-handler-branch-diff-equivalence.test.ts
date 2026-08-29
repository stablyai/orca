import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  gitCommit,
  gitInit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

// Why this file exists: the pinned route replaced the legacy route's own
// `diff --name-status -M -C` rediscovery with values the caller already holds.
// These tests drive the real product contract against real Git and assert the
// two routes agree entry-for-entry, so "SSH still renders what it used to" is
// evidence rather than an argument about call sites.

type BranchCompareResult = {
  summary: { mergeBase: string; headOid: string; status: string; changedFiles: number }
  entries: { path: string; oldPath?: string; status: string }[]
}

type DiffEntry = Record<string, unknown>

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

/**
 * Builds one repo whose base..head range exercises every shape the review
 * panel can hand to a single-file branch diff.
 */
function buildScenarioRepo(): { repoPath: string; baseOid: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'relay-branch-diff-equivalence-'))
  gitInit(repoPath)

  const write = (relativePath: string, contents: string | Buffer): void => {
    const target = path.join(repoPath, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }

  write('modified.txt', 'before\n')
  write('deleted.txt', 'doomed\n')
  write('renamed-from.txt', 'stable rename payload\n')
  write('renamed-and-edited-from.txt', 'rename plus edit, line one\nline two\nline three\n')
  write('copied-source.txt', 'copy me, line one\nline two\nline three\nline four\n')
  write('nested/deep/inner.txt', 'nested before\n')
  write('spaced name.txt', 'spaced before\n')
  write('ünïcode-ページ.txt', 'unicode before\n')
  write('binary-modified.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  write('binary-deleted.bin', Buffer.from([9, 8, 7, 0]))
  write('emptied.txt', 'about to be emptied\n')
  write('crlf.txt', 'crlf before\r\nsecond line\r\n')
  write('mode-changed.sh', '#!/bin/sh\necho hi\n')
  gitCommit(repoPath, 'base')
  const baseOid = git(repoPath, ['rev-parse', 'HEAD']).trim()

  write('modified.txt', 'after\n')
  rmSync(path.join(repoPath, 'deleted.txt'))
  rmSync(path.join(repoPath, 'binary-deleted.bin'))
  git(repoPath, ['mv', 'renamed-from.txt', 'renamed-to.txt'])
  git(repoPath, ['mv', 'renamed-and-edited-from.txt', 'renamed-and-edited-to.txt'])
  write('renamed-and-edited-to.txt', 'rename plus edit, line one\nline two CHANGED\nline three\n')
  write('copied-target.txt', 'copy me, line one\nline two\nline three\nline four\n')
  write('added.txt', 'brand new\n')
  write('binary-added.bin', Buffer.from([4, 4, 0, 4]))
  write('binary-modified.bin', Buffer.from([0, 1, 2, 3, 0, 254]))
  write('nested/deep/inner.txt', 'nested after\n')
  write('spaced name.txt', 'spaced after\n')
  write('ünïcode-ページ.txt', 'unicode after\n')
  write('emptied.txt', '')
  write('crlf.txt', 'crlf after\r\nsecond line\r\n')
  git(repoPath, ['update-index', '--chmod=+x', 'mode-changed.sh'])
  gitCommit(repoPath, 'head')

  return { repoPath, baseOid }
}

describe('pinned and legacy branch diff equivalence against real Git', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let repoPath = ''
  let baseOid = ''

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    const built = buildScenarioRepo()
    repoPath = built.repoPath
    baseOid = built.baseOid
  })

  afterEach(() => {
    handler.dispose()
    if (repoPath) {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })

  async function branchCompare(): Promise<BranchCompareResult> {
    return (await dispatcher.callRequest('git.branchCompare', {
      worktreePath: repoPath,
      baseRef: baseOid
    })) as BranchCompareResult
  }

  async function branchDiff(params: Record<string, unknown>): Promise<DiffEntry[]> {
    return (await dispatcher.callRequest('git.branchDiff', {
      worktreePath: repoPath,
      baseRef: baseOid,
      includePatch: true,
      ...params
    })) as DiffEntry[]
  }

  it('produces identical results for every changed file the review panel can open', async () => {
    const compare = await branchCompare()
    expect(compare.summary.status).toBe('ready')
    // Guard the guard: a truncated scenario set would make this test vacuously pass.
    expect(compare.entries.length).toBeGreaterThanOrEqual(14)

    const divergences: string[] = []
    for (const entry of compare.entries) {
      // Exactly what the renderer sends: paths from the compare entry list,
      // OIDs from the compare summary that produced that same list.
      const callerShape = { filePath: entry.path, oldPath: entry.oldPath }
      const legacy = await branchDiff(callerShape)
      const pinned = await branchDiff({
        ...callerShape,
        baseRef: compare.summary.mergeBase,
        headOid: compare.summary.headOid
      })

      if (JSON.stringify(legacy) !== JSON.stringify(pinned)) {
        divergences.push(
          `${entry.status} ${entry.path}${entry.oldPath ? ` (from ${entry.oldPath})` : ''}\n` +
            `  legacy: ${JSON.stringify(legacy)}\n  pinned: ${JSON.stringify(pinned)}`
        )
      }
    }

    expect(divergences.join('\n')).toBe('')
  })

  it('agrees on content for renames, additions, deletions and binaries specifically', async () => {
    const compare = await branchCompare()
    const byPath = new Map(compare.entries.map((entry) => [entry.path, entry]))

    // Why assert content and not just equality: two identically-empty results
    // would satisfy the equivalence test above while rendering nothing.
    const rename = byPath.get('renamed-and-edited-to.txt')
    expect(rename?.oldPath).toBe('renamed-and-edited-from.txt')
    const [renamePinned] = await branchDiff({
      baseRef: compare.summary.mergeBase,
      headOid: compare.summary.headOid,
      filePath: rename!.path,
      oldPath: rename!.oldPath
    })
    expect(renamePinned).toMatchObject({
      originalContent: 'rename plus edit, line one\nline two\nline three\n',
      modifiedContent: 'rename plus edit, line one\nline two CHANGED\nline three\n'
    })

    const [addedPinned] = await branchDiff({
      baseRef: compare.summary.mergeBase,
      headOid: compare.summary.headOid,
      filePath: 'added.txt'
    })
    expect(addedPinned).toMatchObject({ originalContent: '', modifiedContent: 'brand new\n' })

    const [deletedPinned] = await branchDiff({
      baseRef: compare.summary.mergeBase,
      headOid: compare.summary.headOid,
      filePath: 'deleted.txt'
    })
    expect(deletedPinned).toMatchObject({ originalContent: 'doomed\n', modifiedContent: '' })

    const [binaryPinned] = await branchDiff({
      baseRef: compare.summary.mergeBase,
      headOid: compare.summary.headOid,
      filePath: 'binary-modified.bin'
    })
    expect(binaryPinned).toMatchObject({ kind: 'binary' })
  })

  it('holds the pinned revision when HEAD moves mid-review, where legacy drifts', async () => {
    const compare = await branchCompare()
    writeFileSync(path.join(repoPath, 'modified.txt'), 'drifted after the snapshot\n')
    gitCommit(repoPath, 'drift')

    const pinned = await branchDiff({
      baseRef: compare.summary.mergeBase,
      headOid: compare.summary.headOid,
      filePath: 'modified.txt'
    })
    const legacy = await branchDiff({ filePath: 'modified.txt' })

    expect(pinned[0]).toMatchObject({ modifiedContent: 'after\n' })
    // The divergence is the fix: legacy silently re-resolves live HEAD.
    expect(legacy[0]).toMatchObject({ modifiedContent: 'drifted after the snapshot\n' })
  })
})
