import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import type { GitAdmissionGrant } from '../../../../shared/git/admission/git-admission-state'
import { findGitSubcommandIndex } from '../../../../shared/git/commands/git-command-classification'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/create-preparation'
import { _resetGitAdmissionForTests } from '../../command-runner/admission/git-subprocess-admission'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktree } from './worktree-add'
import { addSparseWorktree } from './worktree-sparse-add'
import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { refreshPreparedWorktreeTip } from './worktree-preparation-tip-refresh'
import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

let root: string
let repo: string
let admission: GitAdmissionScheduler

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-create-admission-'))
  repo = join(root, 'repo')
  admission = new GitAdmissionScheduler()
  _resetGitAdmissionForTests(admission)
  await gitExecFileAsync(['init', '-q', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await mkdir(join(repo, 'included'))
  await writeFile(join(repo, 'included', 'file.txt'), 'one\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetGitAdmissionForTests()
  await rm(root, { recursive: true, force: true })
})

async function behindCheckoutBudget(command: string, run: () => Promise<unknown>): Promise<void> {
  let held: GitAdmissionGrant[] = []
  const requested = Promise.withResolvers<void>()
  let admitted = false
  const acquire = admission.acquire.bind(admission)
  const spy = vi.spyOn(admission, 'acquire').mockImplementation(async (request) => {
    if (request.args[findGitSubcommandIndex(request.args)] === command) {
      held = await Promise.all(
        Array.from({ length: 3 }, () =>
          acquire({
            args: ['worktree', 'add'],
            cwd: repo,
            admissionClass: 'checkout',
            tier: 'interactive'
          })
        )
      )
      const grant = acquire(request)
      requested.resolve()
      void grant.then(() => {
        admitted = true
      })
      return grant
    }
    return acquire(request)
  })
  const operation = run()
  try {
    await requested.promise
    const read = await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd: repo })
    expect(read.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(admitted).toBe(false)
  } finally {
    held.forEach((grant) => grant.release())
    await operation
    spy.mockRestore()
  }
}

it('isolates ordinary and sparse creates while honoring the execution host checkout config', async () => {
  await gitExecFileAsync(['config', 'checkout.workers', 'not-an-integer'], { cwd: repo })
  await expect(addWorktree(repo, join(root, 'invalid'), 'invalid', 'main')).rejects.toThrow()
  await gitExecFileAsync(['config', 'checkout.workers', '0'], { cwd: repo })
  const ordinary = join(root, 'ordinary')
  await behindCheckoutBudget('worktree', () => addWorktree(repo, ordinary, 'ordinary', 'main'))
  expect(await readFile(join(ordinary, 'included', 'file.txt'), 'utf8')).toBe('one\n')
  await gitExecFileAsync(['config', '--unset', 'checkout.workers'], { cwd: repo })
  const sparse = join(root, 'sparse')
  await behindCheckoutBudget('checkout', () =>
    addSparseWorktree(repo, sparse, 'sparse', ['included'], 'main')
  )
  expect(await readFile(join(sparse, 'included', 'file.txt'), 'utf8')).toBe('one\n')
})

it('isolates preparation, fetched-tip refresh and changed-head finalization materializations', async () => {
  const prepared = join(root, 'prepared')
  const reason = createWorktreePreparationLockReason('admission')
  await behindCheckoutBudget('reset', () =>
    prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  )
  await writeFile(join(repo, 'included', 'file.txt'), 'two\n')
  await gitExecFileAsync(['commit', '-qam', 'next', '--author=Test <test@example.invalid>'], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
  })
  await behindCheckoutBudget('reset', () =>
    refreshPreparedWorktreeTip(repo, prepared, 'main', reason)
  )
  expect(await readFile(join(prepared, 'included', 'file.txt'), 'utf8')).toBe('two\n')
  await writeFile(join(repo, 'included', 'file.txt'), 'three\n')
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'third'],
    { cwd: repo }
  )
  const target = join(root, 'finalized')
  await behindCheckoutBudget('reset', () =>
    finalizePreparedWorktree(repo, prepared, target, 'finalized', 'main', false, {}, reason)
  )
  expect(await readFile(join(target, 'included', 'file.txt'), 'utf8')).toBe('three\n')
})

it('isolates the production base fast-forward with its leading Git config arguments', async () => {
  const newer = join(root, 'newer')
  await addWorktree(repo, newer, 'newer', 'main')
  await writeFile(join(newer, 'included', 'file.txt'), 'remote\n')
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'remote'],
    { cwd: newer }
  )
  const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: newer })
  await gitExecFileAsync(['update-ref', 'refs/remotes/origin/main', stdout.trim()], { cwd: repo })
  await behindCheckoutBudget('merge', () =>
    refreshLocalBaseRefForWorktreeCreate(repo, 'origin/main', 'refs/remotes/origin/main')
  )
  expect(await readFile(join(repo, 'included', 'file.txt'), 'utf8')).toBe('remote\n')
})
