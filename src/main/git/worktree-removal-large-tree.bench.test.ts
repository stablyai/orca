// Manual benchmark for the `worktree.remove.git_remove` stage on a large checkout.
// Opt in (it builds ~100k files): ORCA_WORKTREE_REMOVAL_BENCH=1 pnpm exec vitest run \
//   --config config/vitest.config.ts src/main/git/worktree-removal-large-tree.bench.test.ts
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeWorktree } from './worktree'
import { getWorktreeTrashRoot, whenWorktreeTrashDeletionsSettled } from '../worktree-trash'

const execFileAsync = promisify(execFile)
const describeBench = process.env.ORCA_WORKTREE_REMOVAL_BENCH ? describe : describe.skip

const FIXTURE_DIRECTORIES = 200
const FIXTURE_FILES_PER_DIRECTORY = 500

describeBench('worktree removal on a large checkout', () => {
  let scratchDir = ''
  let repoPath = ''
  let worktreePath = ''

  async function git(args: string[], cwd: string): Promise<void> {
    await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  }

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'orca-worktree-removal-bench-'))
    repoPath = join(scratchDir, 'repo')
    worktreePath = join(scratchDir, 'workspaces', 'repo', 'bench')
    await mkdir(repoPath, { recursive: true })
    await git(['init', '-q', '-b', 'main'], repoPath)
    await git(['config', 'user.email', 'bench@example.invalid'], repoPath)
    await git(['config', 'user.name', 'Bench'], repoPath)
    await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
    await git(['add', 'seed.txt'], repoPath)
    await git(['commit', '-qm', 'seed'], repoPath)
    await mkdir(join(scratchDir, 'workspaces', 'repo'), { recursive: true })
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'bench'], repoPath)

    // A committed synthetic node_modules-shaped tree: the removal must be clean-checked and deleted.
    for (let dirIndex = 0; dirIndex < FIXTURE_DIRECTORIES; dirIndex += 1) {
      const dir = join(worktreePath, 'node_modules', `pkg-${dirIndex}`)
      await mkdir(dir, { recursive: true })
      await Promise.all(
        Array.from({ length: FIXTURE_FILES_PER_DIRECTORY }, (_unused, fileIndex) =>
          writeFile(join(dir, `file-${fileIndex}.js`), `module.exports = ${fileIndex}\n`)
        )
      )
    }
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-qm', 'large tree'], worktreePath)
  }, 900_000)

  afterAll(async () => {
    await whenWorktreeTrashDeletionsSettled()
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true })
    }
  })

  it('returns from removeWorktree without waiting for the recursive delete', async () => {
    const startedAt = Date.now()
    await removeWorktree(repoPath, worktreePath, false, { deleteBranch: false })
    const userVisibleMs = Date.now() - startedAt

    const trashRoot = getWorktreeTrashRoot(worktreePath)
    console.log(
      `[bench] files=${FIXTURE_DIRECTORIES * FIXTURE_FILES_PER_DIRECTORY} removeWorktree=${userVisibleMs}ms`
    )
    expect(existsSync(worktreePath)).toBe(false)
    const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoPath })
    expect(stdout).not.toContain(worktreePath)

    const backgroundStartedAt = Date.now()
    await whenWorktreeTrashDeletionsSettled()
    console.log(
      `[bench] background deletion=${Date.now() - backgroundStartedAt}ms (trash root ${trashRoot})`
    )
    expect(existsSync(trashRoot)).toBe(true)
    expect(await readdir(trashRoot)).toEqual([])
  }, 900_000)
})
