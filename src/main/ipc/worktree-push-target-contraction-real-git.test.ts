import {
  git,
  execGit,
  REPO_ID,
  FORK_REMOTE,
  scratchDir,
  repoPath,
  forkPath,
  worktreeId,
  forkTarget,
  storeOf
} from './worktree-push-target-reconciliation.test-fixture'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { join } from 'node:path'

import { expect, it } from 'vitest'

import type { GitRemoteExec } from './worktree-push-target-cleanup'

import { cleanupUnusedWorktreePushTargetRemoteWithExec } from './worktree-push-target-cleanup'
import { migrateForkRemoteRefspecsWithExec } from './worktree-push-target-refspec-migration'
import { reconcileOrphanedPrRemotesWithExec } from './worktree-push-target-reconciliation'
it.each(
  ['exact', 'empty', 'prefix-new'].flatMap((shape) =>
    ['cleanup', 'sweep', 'migration', 'native'].map((operation) => ({ shape, operation }))
  )
)(
  'retains independently unmapped refs across persisted $shape migration and later $operation',
  async ({ shape, operation }) => {
    const branch = shape === 'prefix-new' ? 'new' : 'contributor/fix'
    const base = `refs/remotes/${FORK_REMOTE}/`,
      sibling = `${base}${branch}-user`
    const oid = (await git(['rev-parse', 'HEAD'], repoPath)).trim()
    const key = `remote.${FORK_REMOTE}.fetch`
    await git(['config', '--unset-all', key], repoPath)
    if (shape !== 'empty') {
      await git(
        [
          'config',
          '--add',
          key,
          `+refs/heads/contributor/fix${shape === 'exact' ? '' : '*'}:${base}contributor/fix${shape === 'exact' ? '' : '*'}`
        ],
        repoPath
      )
    }
    await git(['update-ref', sibling, oid], repoPath)
    const policy = await git(['config', '--list', '-z'], repoPath)
    const store = storeOf({ [worktreeId('/saved')]: forkTarget({ branchName: branch }) })
    await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, execGit)
    if (shape !== 'prefix-new') {
      expect(await git(['config', '--list', '-z'], repoPath)).toBe(policy)
    }
    expect((await git(['rev-parse', sibling], repoPath)).trim()).toBe(oid)
    // Every row starts with a fresh fixture and a new invocation with no saved target.
    if (operation === 'cleanup') {
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        repoPath,
        worktreeId('/removed'),
        forkTarget(),
        storeOf({}),
        execGit
      )
    } else if (operation === 'sweep') {
      expect(
        await reconcileOrphanedPrRemotesWithExec(
          repoPath,
          REPO_ID,
          storeOf({}),
          execGit,
          async () => []
        )
      ).toEqual([FORK_REMOTE])
    } else if (operation === 'migration') {
      await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, storeOf({}), execGit)
    } else {
      await git(['remote', 'remove', FORK_REMOTE], repoPath)
    }
    expect((await git(['rev-parse', sibling], repoPath)).trim()).toBe(oid)
  }
)

it.each(
  ['cleanup', 'sweep', 'migration'].flatMap((operation) =>
    [
      'live',
      'missing',
      'disabled',
      'absent-branch',
      'noncurrent',
      'included',
      'conditional',
      'dot',
      'url-remote',
      'base',
      'push-remote',
      'push-default',
      'private-policy'
    ].map((context) => ({ operation, context }))
  )
)(
  'retains actual native/raw $context keeper obligations through $operation, then permits positive management',
  async ({ operation, context }) => {
    const keeper = join(scratchDir, 'keeper')
    await git(['worktree', 'add', '-qb', 'keeper', keeper], repoPath)
    await git(['config', 'extensions.worktreeConfig', 'true'], repoPath)
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'], keeper)).trim()
    const ref = `refs/remotes/${FORK_REMOTE}/contributor/fix`,
      oid = await git(['rev-parse', ref], repoPath)
    const branch =
      context === 'absent-branch'
        ? 'saved-but-no-ref'
        : context === 'noncurrent'
          ? 'noncurrent'
          : 'keeper'
    if (context === 'noncurrent') {
      await git(['branch', branch], repoPath)
    }
    if (context === 'included' || context === 'conditional') {
      await writeFile(
        join(gitDir, 'keeper.inc'),
        `[branch "keeper"]\n remote = ${FORK_REMOTE}\n merge = refs/heads/contributor/fix\n`
      )
      await git(
        [
          'config',
          '--worktree',
          context === 'conditional' ? 'includeIf.onbranch:keeper.path' : 'include.path',
          join(gitDir, 'keeper.inc')
        ],
        keeper
      )
    } else if (context === 'private-policy') {
      await git(
        ['config', '--worktree', `remote.${FORK_REMOTE}.receivepack`, 'user-receiver'],
        keeper
      )
    } else if (context === 'base') {
      await git(['config', '--worktree', 'branch.keeper.base', ref], keeper)
    } else if (context === 'push-remote') {
      await git(['config', '--worktree', 'branch.keeper.pushRemote', FORK_REMOTE], keeper)
    } else if (context === 'push-default') {
      await git(['config', '--worktree', 'remote.pushDefault', FORK_REMOTE], keeper)
    } else {
      await git(
        [
          'config',
          '--worktree',
          `branch.${branch}.remote`,
          context === 'dot' ? '.' : context === 'url-remote' ? forkPath : FORK_REMOTE
        ],
        keeper
      )
      await git(
        [
          'config',
          '--worktree',
          `branch.${branch}.merge`,
          context === 'dot' ? ref : 'refs/heads/contributor/fix'
        ],
        keeper
      )
    }
    if (context === 'disabled') {
      await git(['config', '--unset', 'extensions.worktreeConfig'], repoPath)
    }
    const native = ![
      'disabled',
      'absent-branch',
      'push-default',
      'push-remote',
      'base',
      'private-policy',
      'url-remote'
    ].includes(context)
    if (native) {
      expect(await git(['rev-parse', `${branch}@{u}`], keeper)).toBe(oid)
    }
    if (context === 'missing') {
      await rm(keeper, { recursive: true, force: true })
    }
    const store = storeOf({})
    const act = () =>
      operation === 'cleanup'
        ? cleanupUnusedWorktreePushTargetRemoteWithExec(
            repoPath,
            worktreeId('/gone'),
            forkTarget(),
            store,
            execGit
          )
        : operation === 'sweep'
          ? reconcileOrphanedPrRemotesWithExec(repoPath, REPO_ID, store, execGit, async () => [])
          : migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, execGit)
    await act()
    expect(await git(['remote'], repoPath)).toContain(FORK_REMOTE)
    expect(await git(['rev-parse', ref], repoPath)).toBe(oid)
    if (native) {
      expect(await git(['--git-dir=.', 'rev-parse', `${branch}@{u}`], gitDir)).toBe(oid)
    }
    // Delete the actual saved source; a later ordinary invocation derives the new lifetime.
    await writeFile(join(gitDir, 'config.worktree'), '')
    await act()
    if (operation === 'migration') {
      await expect(
        git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath)
      ).rejects.toThrow()
      await expect(git(['rev-parse', '--verify', ref], repoPath)).rejects.toThrow()
    } else {
      expect(await git(['remote'], repoPath)).not.toContain(FORK_REMOTE)
    }
  }
)

it.each(
  ['cleanup', 'sweep', 'migration'].flatMap((operation) =>
    [
      'registration',
      'head',
      'private-policy',
      'broken-common',
      'inactive-include',
      'read-error'
    ].map((race) => ({ operation, race }))
  )
)(
  'preserves zero destructive writes through $operation on contextual $race freshness uncertainty',
  async ({ operation, race }) => {
    const keeper = join(scratchDir, 'keeper')
    await git(['worktree', 'add', '-qb', 'keeper', keeper], repoPath)
    const admin = (await git(['rev-parse', '--absolute-git-dir'], keeper)).trim()
    await git(['config', 'extensions.worktreeConfig', 'true'], repoPath)
    if (race === 'inactive-include') {
      await git(
        ['config', '--worktree', 'includeIf.onbranch:future.path', join(admin, 'unread-future')],
        keeper
      )
    }
    const calls: string[][] = []
    let reads = 0
    const run: GitRemoteExec = async (args, cwd) => {
      calls.push(args)
      if (args.includes('--show-origin') && cwd === repoPath && ++reads === 2) {
        if (race === 'read-error') {
          throw new Error('context policy read denied')
        }
        if (race === 'registration') {
          await git(['worktree', 'add', '-qb', 'late', join(scratchDir, 'late')], repoPath)
        }
        if (race === 'head') {
          await git(['symbolic-ref', 'HEAD', 'refs/heads/unborn-late'], keeper)
        }
        if (race === 'private-policy') {
          await git(
            ['config', '--worktree', `remote.${FORK_REMOTE}.pushurl`, '/other-receiver'],
            keeper
          )
        }
        if (race === 'broken-common') {
          await writeFile(join(admin, 'commondir'), '../../elsewhere\n')
        }
      }
      return execGit(args, cwd)
    }
    if (operation === 'cleanup') {
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        repoPath,
        worktreeId('/gone'),
        forkTarget(),
        storeOf({}),
        run
      )
    } else if (operation === 'sweep') {
      await reconcileOrphanedPrRemotesWithExec(repoPath, REPO_ID, storeOf({}), run, async () => [])
    } else {
      await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, storeOf({}), run)
    }
    expect(
      calls.some(
        (args) =>
          args.includes('remove') ||
          args.includes('--add') ||
          args.includes('--unset-all') ||
          args[0] === 'update-ref'
      )
    ).toBe(false)
    expect(await git(['remote'], repoPath)).toContain(FORK_REMOTE)
  }
)

it.each(
  ['remotes', 'branches'].flatMap((store) =>
    ['cleanup', 'sweep', 'migration'].map((operation) => ({ store, operation }))
  )
)(
  'retains suppressed $store native removal effects but permits safe $operation contraction',
  async ({ store, operation }) => {
    const directory = join(repoPath, '.git', store)
    await mkdir(directory)
    const file = join(directory, FORK_REMOTE)
    const raw =
      store === 'remotes'
        ? `URL: ${forkPath}-other\nPull: refs/heads/private:refs/private/untouched\n`
        : `${forkPath}-other#private\n`
    await writeFile(file, raw)
    const before = await git(['config', '--list', '-z'], repoPath)
    const act = () =>
      operation === 'cleanup'
        ? cleanupUnusedWorktreePushTargetRemoteWithExec(
            repoPath,
            worktreeId('/removed'),
            forkTarget(),
            storeOf({}),
            execGit
          )
        : operation === 'sweep'
          ? reconcileOrphanedPrRemotesWithExec(
              repoPath,
              REPO_ID,
              storeOf({}),
              execGit,
              async () => []
            )
          : migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, storeOf({}), execGit)
    await act()
    expect(await readFile(file, 'utf8')).toBe(raw)
    expect(await git(['remote', 'get-url', FORK_REMOTE], repoPath)).toBe(`${forkPath}\n`)
    if (operation === 'migration') {
      await expect(
        git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath)
      ).rejects.toThrow()
    } else {
      expect(await git(['config', '--list', '-z'], repoPath)).toBe(before)
    }
    await rm(file)
    await (operation === 'migration'
      ? cleanupUnusedWorktreePushTargetRemoteWithExec(
          repoPath,
          worktreeId('/removed'),
          forkTarget(),
          storeOf({}),
          execGit
        )
      : act())
    expect(await git(['remote'], repoPath)).not.toContain(FORK_REMOTE)
  }
)
