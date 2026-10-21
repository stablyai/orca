// Manual benchmark: how long removing a large checkout takes, and how slow a store-style write gets
// meanwhile. Opt in (it builds ~100k files): ORCA_WORKTREE_REMOVAL_BENCH=1 ./node_modules/.bin/vitest \
//   run --config config/vitest.config.ts src/main/git/worktree-removal-large-tree.bench.test.ts
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeWorktree } from './worktree'

const execFileAsync = promisify(execFile)
const describeBench = process.env.ORCA_WORKTREE_REMOVAL_BENCH ? describe : describe.skip

const FIXTURE_DIRECTORIES = 200
const FIXTURE_FILES_PER_DIRECTORY = 500
const STORE_FILE_BYTES = 2 * 1024 * 1024
const STORE_TRANSACTION_INTERVAL_MS = 20

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
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true })
    }
  })

  it('reports removal time and store-write latency during the delete', async () => {
    // Outside hard links drop to one link only once the checkout's copies are gone, wherever the
    // delete runs, so the window covers the whole delete rather than just the call.
    const sentinelRoot = join(scratchDir, 'sentinels')
    await mkdir(sentinelRoot)
    const sentinels: string[] = []
    for (let dirIndex = 0; dirIndex < FIXTURE_DIRECTORIES; dirIndex += 10) {
      const sentinel = join(sentinelRoot, `pkg-${dirIndex}`)
      await link(join(worktreePath, 'node_modules', `pkg-${dirIndex}`, 'file-0.js'), sentinel)
      sentinels.push(sentinel)
    }
    const checkoutDeleted = (): boolean => sentinels.every((path) => statSync(path).nlink === 1)
    const storePath = join(scratchDir, 'store.json')
    await writeFile(storePath, Buffer.alloc(STORE_FILE_BYTES, 1))

    // Mirrors a persisted-store write: read, write a temp file, fsync it, rename it into place.
    const storeTransaction = async (): Promise<number> => {
      const startedAt = performance.now()
      const contents = await readFile(storePath)
      const tempPath = `${storePath}.tmp`
      const handle = await open(tempPath, 'w')
      try {
        await handle.writeFile(contents)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, storePath)
      return performance.now() - startedAt
    }
    const idleMs: number[] = []
    for (let index = 0; index < 10; index += 1) {
      idleMs.push(await storeTransaction())
    }

    let removalReturnedMs = 0
    const startedAt = performance.now()
    const removal = removeWorktree(repoPath, worktreePath, false, { deleteBranch: false }).then(
      () => {
        removalReturnedMs = performance.now() - startedAt
      }
    )
    const duringMs: number[] = []
    while (!removalReturnedMs || !checkoutDeleted()) {
      const transactionStartedAt = performance.now()
      duringMs.push(await storeTransaction())
      const wait = STORE_TRANSACTION_INTERVAL_MS - (performance.now() - transactionStartedAt)
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    const deletedMs = performance.now() - startedAt
    await removal

    const percentile = (values: number[], p: number): number => {
      const sorted = [...values].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
    }
    const line =
      `[bench] files=${FIXTURE_DIRECTORIES * FIXTURE_FILES_PER_DIRECTORY}` +
      ` removeWorktree=${removalReturnedMs.toFixed(0)}ms checkoutDeleted=${deletedMs.toFixed(0)}ms` +
      ` storeIdle p50=${percentile(idleMs, 50).toFixed(1)}ms` +
      ` storeDuring n=${duringMs.length} p50=${percentile(duringMs, 50).toFixed(1)}ms` +
      ` p90=${percentile(duringMs, 90).toFixed(1)}ms max=${Math.max(...duringMs).toFixed(1)}ms`
    console.log(line)
    if (process.env.ORCA_WORKTREE_REMOVAL_BENCH_LOG) {
      appendFileSync(process.env.ORCA_WORKTREE_REMOVAL_BENCH_LOG, `${line}\n`)
    }
    expect(existsSync(worktreePath)).toBe(false)
    const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoPath })
    expect(stdout).not.toContain(worktreePath)
  }, 900_000)
})
