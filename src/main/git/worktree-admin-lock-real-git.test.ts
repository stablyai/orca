import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './runner'
import { listWorktrees } from './worktree'
import { addWorktree } from './worktree-add'
import {
  discardPreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { worktreeCreateGit } from './worktree-create-git-executor'
import { consumePreparedWorktreeCreate } from '../worktree-create-preparation'
import {
  _resetPreparationPoolForTests,
  startPreparation
} from '../worktree-create-preparation-pool'
import {
  _gitOperationLockHeldForTests,
  _gitOperationLockWaiterCountForTests
} from '../../shared/git-operation-lock'
import {
  _resolveGitWorktreeAdminLockKeyForTests,
  runWithGitWorktreeAdminLock
} from '../../shared/git-worktree-admin-lock'
import { _resetGitSpanSamplingForTests, withWorktreeSpan } from '../observability/instrumentation'
import { setActiveSink } from '../observability/tracer'

type SpanRecord = {
  name: string
  spanId: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, unknown>
}

function isSpanRecord(value: unknown): value is SpanRecord {
  return typeof value === 'object' && value !== null && 'name' in value && 'attributes' in value
}

const roots: string[] = []
afterEach(async () => {
  setActiveSink(null)
  await _resetPreparationPoolForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRepo(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-admin-lock-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const commit = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm']
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'main\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync([...commit, 'main'], { cwd: repo })
  await gitExecFileAsync(['branch', 'other'], { cwd: repo })
  return { root, repo }
}

function isAdminMutation(span: SpanRecord): boolean {
  return span.name === 'git.exec' && 'git.worktree_admin_lock_wait_ms' in span.attributes
}

it('serializes a pool re-arm and a create in one repo, and runs the create first', async () => {
  const { root, repo } = await createRepo()
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

  // Hold the repo's admin lane so both sides are provably queued before either runs.
  const key = await _resolveGitWorktreeAdminLockKeyForTests(repo)
  let releaseHolder!: () => void
  const holderStarted = Promise.withResolvers<void>()
  const holder = runWithGitWorktreeAdminLock({ cwd: repo }, undefined, async () => {
    holderStarted.resolve()
    await new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
  })
  await holderStarted.promise
  const heldFrom = spans.length

  const rearm = startPreparation({
    repoPath: repo,
    workspaceRoot: root,
    baseBranch: 'other',
    canonicalBase: 'refs/heads/other',
    options: {},
    reason: 'rearm'
  })
  await vi.waitFor(() => expect(_gitOperationLockWaiterCountForTests(key)).toBe(1), {
    timeout: 15_000
  })

  const created = withWorktreeSpan({ stage: 'create' }, () =>
    worktreeCreateGit.run(() =>
      consumePreparedWorktreeCreate({
        repoPath: repo,
        workspaceRoot: root,
        worktreePath: join(root, 'created'),
        branch: 'created',
        baseBranch: 'main'
      })
    )
  )
  await vi.waitFor(() => expect(_gitOperationLockWaiterCountForTests(key)).toBe(2), {
    timeout: 15_000
  })
  expect(spans.slice(heldFrom).filter(isAdminMutation)).toEqual([])

  releaseHolder()
  await holder
  const [attempt] = await Promise.all([created, rearm])
  expect(attempt.status).toBe('hit')
  expect(await readFile(join(root, 'created', 'file.txt'), 'utf8')).toBe('main\n')
  expect(await listWorktrees(repo, { includeCreatePreparations: true })).toHaveLength(3)

  const admin = spans
    .slice(heldFrom)
    .filter(isAdminMutation)
    .sort((left, right) => Number(BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano)))
  for (let index = 1; index < admin.length; index += 1) {
    expect(BigInt(admin[index].startTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(admin[index - 1].endTimeUnixNano)
    )
  }

  const createSpan = spans.find((span) => span.name === 'worktree.create')
  const prepareSpans = spans.filter((span) => span.name === 'worktree.prepare')
  const rearmSpan = prepareSpans.find(
    (span) => span.attributes['worktree.prepare.reason'] === 'rearm'
  )
  expect(createSpan).toBeDefined()
  expect(rearmSpan).toBeDefined()
  // The create's queued `worktree move` was granted ahead of the earlier-queued re-arm `worktree add`.
  expect(admin[0].attributes['git.operation']).toBe('worktree.create')
  expect(admin[0].attributes['git.operation_span_id']).toBe(createSpan?.spanId)
  expect(admin.some((span) => span.attributes['git.operation_span_id'] === rearmSpan?.spanId)).toBe(
    true
  )
})

it.skipIf(process.platform === 'win32')(
  'checks out and runs post-checkout after the admin lane is released',
  async () => {
    const { root, repo } = await createRepo()
    const hookLog = join(root, 'hook.log')
    const hookRelease = join(root, 'hook.release')
    const hookPath = join(repo, '.git', 'hooks', 'post-checkout')
    await writeFile(
      hookPath,
      [
        '#!/bin/sh',
        `printf '%s %s %s %s\\n' "$1" "$2" "$3" "$(cat file.txt)" > '${hookLog}'`,
        `while [ ! -e '${hookRelease}' ]; do sleep 0.05; done`,
        ''
      ].join('\n')
    )
    await chmod(hookPath, 0o755)
    const key = await _resolveGitWorktreeAdminLockKeyForTests(repo)

    const created = addWorktree(repo, join(root, 'created'), 'created', 'main')
    await vi.waitFor(() => stat(hookLog), { timeout: 15_000 })
    // The hook is still running, so the checkout it saw is complete and the lane must be free.
    expect(_gitOperationLockHeldForTests(key)).toBe(false)
    await gitExecFileAsync(['worktree', 'prune'], { cwd: repo })

    await writeFile(hookRelease, '')
    await created
    const head = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    expect(await readFile(hookLog, 'utf8')).toBe(`${'0'.repeat(head.length)} ${head} 1 main\n`)
  },
  30_000
)

it.skipIf(process.platform === 'win32')(
  'unregisters the worktree when the create is cancelled mid-checkout',
  async () => {
    const { root, repo } = await createRepo()
    const filterStarted = join(root, 'filter.started')
    const filterRelease = join(root, 'filter.release')
    await writeFile(join(repo, '.gitattributes'), 'slow.txt filter=slow\n')
    await writeFile(join(repo, 'slow.txt'), 'slow\n')
    await gitExecFileAsync(['add', '.'], { cwd: repo })
    await gitExecFileAsync(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'slow'],
      { cwd: repo }
    )
    // A smudge filter that blocks keeps the checkout in flight until the test cancels it.
    await gitExecFileAsync(
      [
        'config',
        'filter.slow.smudge',
        `touch '${filterStarted}'; while [ ! -e '${filterRelease}' ]; do sleep 0.05; done; cat`
      ],
      { cwd: repo }
    )
    const worktreePath = join(root, 'created')
    const controller = new AbortController()
    const created = addWorktree(repo, worktreePath, 'created', 'main', false, false, {
      signal: controller.signal
    })
    try {
      await vi.waitFor(() => stat(filterStarted), { timeout: 15_000 })
      controller.abort()
      await expect(created).rejects.toThrow()
    } finally {
      await writeFile(filterRelease, '')
    }
    const listed = await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })
    expect(listed.stdout).not.toContain(worktreePath)
  },
  30_000
)

it('deletes a prepared checkout without queueing on a held admin lane', async () => {
  const { root, repo } = await createRepo()
  const prepared = join(root, 'prepared')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', 'orca test')
  let releaseHolder!: () => void
  const holderStarted = Promise.withResolvers<void>()
  const holder = runWithGitWorktreeAdminLock({ cwd: repo }, undefined, async () => {
    holderStarted.resolve()
    await new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
  })
  await holderStarted.promise
  try {
    await discardPreparedWorktree(repo, prepared)
    await expect(stat(prepared)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    releaseHolder()
    await holder
  }
}, 10_000)
