import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as operationLocks from '../../shared/git/commands/git-operation-lock'
import {
  createStandaloneBranchRepo,
  runDisposableGit
} from './standalone-branch-deletion.test-fixture'
import { checkoutBranch } from './checkout'
import { addWorktree } from './worktrees/creation/worktree-add'
import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktrees/creation/worktree-create-preparation'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import { runWithLocalBranchCleanup } from './worktrees/removal/worktree-branch-removal'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

let directory: string
beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', undefined)
  vi.stubEnv('GIT_CONFIG_PARAMETERS', undefined)
  installRealWorkerThreadChildProcesses()
  ;({ directory } = await createStandaloneBranchRepo())
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

async function verifyAttachmentWaits(attach: () => Promise<unknown>, final?: string) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cleanup = runWithLocalBranchCleanup(directory, {}, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const requested = Promise.withResolvers<void>()
  const original = operationLocks.runWithGitOperationLock
  vi.spyOn(operationLocks, 'runWithGitOperationLock').mockImplementation((key, signal, run) => {
    const operation = original(key, signal, run)
    requested.resolve()
    return operation
  })
  const attachment = attach()
  try {
    // A real lane request or a completed unfenced mutation decides this race, without timers.
    await Promise.race([requested.promise, attachment])
    expect(await readFile(join(directory, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(
      await runDisposableGit(directory, 'for-each-ref', '--format=%(refname)', 'refs/heads/created')
    ).toBe('')
    expect(
      (await runDisposableGit(directory, 'worktree', 'list', '--porcelain')).includes(
        'branch refs/heads/feature'
      )
    ).toBe(false)
    if (final) {
      expect(existsSync(final)).toBe(false)
    }
  } finally {
    release.resolve()
    await cleanup
    await attachment
  }
}

it('keeps checkout from attaching while repository deletion owns its fence', async () => {
  await verifyAttachmentWaits(() => checkoutBranch(directory, 'feature'))
  expect(await runDisposableGit(directory, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature')
})

it('uses the same fence when checkout runs inside a linked worktree', async () => {
  const linked = join(directory, 'linked')
  await runDisposableGit(directory, 'worktree', 'add', '--detach', linked, 'main')
  await verifyAttachmentWaits(() => checkoutBranch(linked, 'feature'))
  expect(await runDisposableGit(linked, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature')
})

it('keeps an existing-branch worktree add behind repository deletion', async () => {
  const final = join(directory, 'final')
  await verifyAttachmentWaits(
    () =>
      addWorktree(directory, final, 'feature', 'main', false, false, {
        checkoutExistingBranch: true
      }),
    final
  )
  expect(await runDisposableGit(final, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature')
})

it('keeps new branch creation and attachment behind repository deletion', async () => {
  const final = join(directory, 'final')
  await verifyAttachmentWaits(() => addWorktree(directory, final, 'created', 'main'), final)
  expect(await runDisposableGit(final, 'symbolic-ref', 'HEAD')).toBe('refs/heads/created')
})

it('keeps preparation finalization behind repository deletion', async () => {
  const prepared = join(directory, 'prepared')
  const final = join(directory, 'final')
  const reason = createWorktreePreparationLockReason('attachment-fence')
  await prepareWorktreeCreateCheckout(directory, prepared, 'main', reason)
  await verifyAttachmentWaits(
    () =>
      finalizePreparedWorktree(directory, prepared, final, 'created', 'main', false, {}, reason),
    final
  )
  expect(await runDisposableGit(final, 'symbolic-ref', 'HEAD')).toBe('refs/heads/created')
})

it('allows a different repository to attach while deletion holds its repository fence', async () => {
  const other = await createStandaloneBranchRepo()
  try {
    await runWithLocalBranchCleanup(directory, {}, async () => {
      await checkoutBranch(other.directory, 'feature')
      expect(await runDisposableGit(other.directory, 'symbolic-ref', 'HEAD')).toBe(
        'refs/heads/feature'
      )
    })
  } finally {
    await rm(other.directory, { recursive: true, force: true })
  }
})
