// Opt in: ORCA_WORKTREE_ADMIN_BENCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/git/worktree-admin-contention.bench.test.ts
//
// One repo with several hundred linked worktrees. Each trial arms a prepared checkout, then runs a
// pool re-arm and a create that consumes the armed checkout at the same time, and prints every git
// command inside the create's trace with its duration and admin-lock wait, one JSON line per trial
// to ORCA_WORKTREE_ADMIN_BENCH_RESULT.
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { worktreeCreateGit } from './worktree-create-git-executor'
import { consumePreparedWorktreeCreate } from '../worktree-create-preparation'
import {
  _resetPreparationPoolForTests,
  startPreparation
} from '../worktree-create-preparation-pool'
import { _resetGitSpanSamplingForTests, withWorktreeSpan } from '../observability/instrumentation'
import { setActiveSink } from '../observability/tracer'

const describeBench = process.env.ORCA_WORKTREE_ADMIN_BENCH ? describe : describe.skip
const WORKTREE_COUNT = Number(process.env.ORCA_WORKTREE_ADMIN_BENCH_WORKTREES ?? 600)
const FILE_COUNT = Number(process.env.ORCA_WORKTREE_ADMIN_BENCH_FILES ?? 4000)
const TRIALS = Number(process.env.ORCA_WORKTREE_ADMIN_BENCH_TRIALS ?? 3)
const RESULT_PATH = process.env.ORCA_WORKTREE_ADMIN_BENCH_RESULT

type SpanRecord = {
  name: string
  traceId: string
  spanId: string
  startTimeUnixNano: string
  durationMs: number
  attributes: Record<string, unknown>
}

function isSpanRecord(value: unknown): value is SpanRecord {
  return typeof value === 'object' && value !== null && 'name' in value && 'attributes' in value
}

let root = ''
let repo = ''

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
}

describeBench('worktree admin contention with several hundred worktrees', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-admin-bench-')))
    repo = join(root, 'repo')
    await mkdir(join(repo, 'src'), { recursive: true })
    git(root, ['init', '--quiet', repo])
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, index) =>
        writeFile(join(repo, 'src', `file-${index}.txt`), `content ${index}\n`.repeat(64))
      )
    )
    git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=B', '-c', 'user.email=b@example.com', 'commit', '-qm', 'fixture'])
    git(repo, ['branch', 'other'])
    for (let index = 0; index < WORKTREE_COUNT; index += 1) {
      git(repo, [
        'worktree',
        'add',
        '--quiet',
        '--detach',
        '--no-checkout',
        join(root, 'wt', `${index}`)
      ])
    }
  }, 600_000)

  afterAll(async () => {
    setActiveSink(null)
    await _resetPreparationPoolForTests()
    await rm(root, { recursive: true, force: true })
  })

  it('reports per-command timings inside one prepared-hit create', async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const spans: SpanRecord[] = []
      _resetGitSpanSamplingForTests()
      setActiveSink({
        push: (record) => {
          if (isSpanRecord(record)) {
            spans.push(record)
          }
        },
        flush: () => {},
        close: () => {}
      })
      await startPreparation({
        repoPath: repo,
        workspaceRoot: root,
        baseBranch: 'main',
        canonicalBase: 'refs/heads/main',
        options: {},
        reason: 'prefetch'
      })
      const startedAt = performance.now()
      const rearm = startPreparation({
        repoPath: repo,
        workspaceRoot: root,
        baseBranch: 'other',
        canonicalBase: 'refs/heads/other',
        options: {},
        reason: 'rearm'
      })
      const create = withWorktreeSpan({ stage: 'create' }, () =>
        worktreeCreateGit.run(() =>
          consumePreparedWorktreeCreate({
            repoPath: repo,
            workspaceRoot: root,
            worktreePath: join(root, 'created', `${trial}`),
            branch: `created-${trial}`,
            baseBranch: 'main'
          })
        )
      )
      const [attempt] = await Promise.all([create, rearm])
      const totalMs = performance.now() - startedAt
      expect(attempt.status).toBe('hit')
      const createSpan = spans.find((span) => span.name === 'worktree.create')
      const t0 = BigInt(createSpan?.startTimeUnixNano ?? '0')
      const rows = spans
        .filter((span) => span.name === 'git.exec' && span.traceId === createSpan?.traceId)
        .sort((l, r) => Number(BigInt(l.startTimeUnixNano) - BigInt(r.startTimeUnixNano)))
        .map((span) => ({
          atMs: Number((BigInt(span.startTimeUnixNano) - t0) / 1_000_000n),
          command: span.attributes['git.subcommand'],
          args: span.attributes['git.arg_count'],
          ms: Math.round(span.durationMs),
          adminLockWaitMs: span.attributes['git.worktree_admin_lock_wait_ms'] ?? null
        }))
      const awaited = spans.find((span) => span.name === 'worktree.create.await_preparation')
      const line = JSON.stringify({
        trial,
        worktrees: WORKTREE_COUNT,
        createMs: Math.round(createSpan?.durationMs ?? 0),
        createAndRearmMs: Math.round(totalMs),
        awaitPreparationMs: awaited ? Math.round(awaited.durationMs) : null,
        rows
      })
      if (RESULT_PATH) {
        await appendFile(RESULT_PATH, `${line}\n`)
      }
      await _resetPreparationPoolForTests()
    }
  }, 900_000)
})
