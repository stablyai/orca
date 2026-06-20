import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHunkPatch, parseFileDiff } from '../../shared/git-hunk-patch'
import { applyIndexPatch, getFileDiffPatch } from './status'

const tempRoots: string[] = []

// Why: two changes far enough apart (3+ context lines) to land in separate git
// hunks, so a single-hunk patch can be staged while the other stays unstaged.
const ORIGINAL = `${Array.from({ length: 12 }, (_, i) => String(i + 1)).join('\n')}\n`
const MODIFIED = ORIGINAL.replace('2\n', '2x\n').replace('11\n', '11x\n')

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-hunk-patch-'))
  tempRoots.push(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(path.join(repo, 'file.txt'), ORIGINAL)
  execFileSync('git', ['add', 'file.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  await writeFile(path.join(repo, 'file.txt'), MODIFIED)
  return repo
}

function cachedDiff(repo: string): string {
  return execFileSync('git', ['diff', '--cached', '--', 'file.txt'], {
    cwd: repo,
    encoding: 'utf8'
  })
}

function worktreeDiff(repo: string): string {
  return execFileSync('git', ['diff', '--', 'file.txt'], { cwd: repo, encoding: 'utf8' })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('per-hunk index patching', () => {
  it('stages only the selected hunk and leaves the rest unstaged', async () => {
    const repo = await createRepo()
    const patch = await getFileDiffPatch(repo, 'file.txt', false)
    const parsed = parseFileDiff(patch)
    expect(parsed.hunks).toHaveLength(2)

    await applyIndexPatch(repo, buildHunkPatch(parsed, [0]), false)

    expect(cachedDiff(repo)).toContain('+2x')
    expect(cachedDiff(repo)).not.toContain('+11x')
    // The unselected change is still a working-tree-only modification.
    expect(worktreeDiff(repo)).toContain('+11x')
  })

  it('unstages only the selected hunk with reverse', async () => {
    const repo = await createRepo()
    execFileSync('git', ['add', 'file.txt'], { cwd: repo })
    expect(cachedDiff(repo)).toContain('+2x')
    expect(cachedDiff(repo)).toContain('+11x')

    const staged = await getFileDiffPatch(repo, 'file.txt', true)
    const parsed = parseFileDiff(staged)
    expect(parsed.hunks).toHaveLength(2)

    await applyIndexPatch(repo, buildHunkPatch(parsed, [0]), true)

    expect(cachedDiff(repo)).not.toContain('+2x')
    expect(cachedDiff(repo)).toContain('+11x')
  })

  it('rejects a stale patch without corrupting the index', async () => {
    const repo = await createRepo()
    const patch = await getFileDiffPatch(repo, 'file.txt', false)
    const parsed = parseFileDiff(patch)
    // Stage everything first so the worktree-vs-index hunk no longer applies.
    execFileSync('git', ['add', 'file.txt'], { cwd: repo })

    await expect(applyIndexPatch(repo, buildHunkPatch(parsed, [0]), false)).rejects.toThrow()
  })
})
