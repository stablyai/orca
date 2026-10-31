import {
  isolatedGitEnv,
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

import { readFile, rm, writeFile } from 'node:fs/promises'

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { GitRemoteExec } from './worktree-push-target-cleanup'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { cleanupUnusedWorktreePushTargetRemoteWithExec } from './worktree-push-target-cleanup'
import { migrateForkRemoteRefspecsWithExec } from './worktree-push-target-refspec-migration'
import { reconcileOrphanedPrRemotesWithExec } from './worktree-push-target-reconciliation'
describe('reconcileOrphanedPrRemotesWithExec against the real Git binary', () => {
  it('leaves a user-created remote alone: naming/URL shape is not proof of provenance', async () => {
    await git(['config', '--unset', `remote.${FORK_REMOTE}.orca-created`], repoPath)
    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({}),
      execGit,
      async () => []
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('leaves the remote alone while a live worktree still references it', async () => {
    const worktreePath = join(scratchDir, 'wt-live')
    await git(['worktree', 'add', '-q', worktreePath, '-b', 'contributor/fix-local'], repoPath)

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(worktreePath)]: forkTarget() }),
      execGit,
      async () => [worktreePath]
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('leaves the remote alone while its branch still exists (preserve-on-delete kept alive)', async () => {
    await git(['branch', 'contributor/fix', `${FORK_REMOTE}/contributor/fix`], repoPath)
    await git(['config', `branch.contributor/fix.remote`, FORK_REMOTE], repoPath)

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(join(scratchDir, 'wt-gone'))]: forkTarget() }),
      execGit,
      async () => []
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
  })

  it('retains absent-branch raw config until its removal releases the remote (path 2)', async () => {
    await git(['branch', 'contributor/fix', `${FORK_REMOTE}/contributor/fix`], repoPath)
    await git(['config', `branch.contributor/fix.remote`, FORK_REMOTE], repoPath)
    // Absent branches still contribute saved native configuration obligations.
    await rm(join(repoPath, '.git', 'refs', 'heads', 'contributor', 'fix'))

    const reclaimed = await reconcileOrphanedPrRemotesWithExec(
      repoPath,
      REPO_ID,
      storeOf({ [worktreeId(join(scratchDir, 'wt-gone'))]: forkTarget() }),
      execGit,
      async () => []
    )
    expect(reclaimed).toEqual([])
    await expect(git(['remote'], repoPath)).resolves.toContain(FORK_REMOTE)
    await expect(git(['config', 'branch.contributor/fix.remote'], repoPath)).resolves.toBe(
      `${FORK_REMOTE}\n`
    )
    await git(['config', '--remove-section', 'branch.contributor/fix'], repoPath)
    expect(
      await reconcileOrphanedPrRemotesWithExec(
        repoPath,
        REPO_ID,
        storeOf({ [worktreeId(join(scratchDir, 'wt-gone'))]: forkTarget() }),
        execGit,
        async () => []
      )
    ).toEqual([FORK_REMOTE])
    await expect(git(['remote'], repoPath)).resolves.not.toContain(FORK_REMOTE)
  })

  it.each(
    ['cleanup', 'sweep'].flatMap((operation) =>
      ['wide', 'empty', 'valueless'].map((policy) => ({ operation, policy }))
    )
  )(
    'reclaims a locally marked $policy external orphan through $operation',
    async ({ operation, policy }) => {
      const worktreePath = join(scratchDir, 'wt-externally-removed')
      await git(['worktree', 'add', '-q', worktreePath, '-b', 'contributor/fix-local-2'], repoPath)
      // External worktree removal leaves stale Orca metadata without a cleanup event.
      await git(['worktree', 'remove', '--force', worktreePath], repoPath)

      if (policy === 'valueless') {
        const configPath = join(repoPath, '.git', 'config')
        await writeFile(
          configPath,
          (await readFile(configPath, 'utf8')).replace(
            /orca-created = true(?=\r?\n)/,
            'orca-created'
          )
        )
      }
      if (policy === 'empty') {
        await git(['config', '--unset-all', `remote.${FORK_REMOTE}.fetch`], repoPath)
      }
      if (operation === 'cleanup') {
        await cleanupUnusedWorktreePushTargetRemoteWithExec(
          repoPath,
          worktreeId(worktreePath),
          forkTarget(),
          storeOf({ [worktreeId(worktreePath)]: forkTarget() }),
          execGit
        )
      } else {
        expect(
          await reconcileOrphanedPrRemotesWithExec(
            repoPath,
            REPO_ID,
            storeOf({ [worktreeId(worktreePath)]: forkTarget() }),
            execGit,
            async () => []
          )
        ).toEqual([FORK_REMOTE])
      }
      await expect(git(['remote'], repoPath)).resolves.not.toContain(FORK_REMOTE)
      if (policy === 'empty') {
        await expect(
          git(['rev-parse', `refs/remotes/${FORK_REMOTE}/contributor/fix`], repoPath)
        ).resolves.toBeDefined()
      }
    }
  )
})

const protectedCases = [
  'pushDefault',
  'url-pushDefault',
  'rewritten-pushDefault',
  'pushremote',
  'remote/merge',
  'multiple-merges',
  'dot',
  'dot-absent',
  'branch.base',
  'baseRef',
  'sparseBaseRef',
  'unknown-host',
  'global-marker',
  'empty-marker',
  'false-metadata',
  'false-hint',
  'custom-base',
  'custom-policy',
  'internal-wildcard',
  'malformed-head',
  'mirror-policy',
  'overlap-policy',
  'tag-policy',
  'pushurl',
  'global-pushurl',
  'url-multivar',
  'global-fetch',
  'filter',
  'receivepack',
  'unknown-key'
]
it.each(
  protectedCases.flatMap((dependency) =>
    ['cleanup', 'sweep', 'migration'].map((operation) => ({ dependency, operation }))
  )
)(
  'protects $dependency through $operation with a fresh fixture',
  async ({ dependency, operation }) => {
    let ref = `refs/remotes/${FORK_REMOTE}/contributor/fix`
    const oid = await git(['rev-parse', ref], repoPath)
    const meta = mergeWorktreeMetaForWrite(undefined, {})
    if (dependency === 'empty-marker') {
      await git(['config', `${`remote.${FORK_REMOTE}`}.orca-created`, ''], repoPath)
    }
    if (dependency === 'tag-policy') {
      await git(['config', `remote.${FORK_REMOTE}.tagOpt`, '--tags'], repoPath)
    }
    if (dependency === 'rewritten-pushDefault') {
      await git(['config', `url.${forkPath}.insteadOf`, 'fork-source:'], repoPath)
      await git(['config', 'remote.pushDefault', 'fork-source:'], repoPath)
    }
    if (['custom-policy', 'custom-base'].includes(dependency)) {
      await git(
        ['config', '--replace-all', `remote.${FORK_REMOTE}.fetch`, '+refs/heads/*:refs/private/*'],
        repoPath
      )
    }
    if (dependency === 'internal-wildcard') {
      await git(
        [
          'config',
          '--replace-all',
          `remote.${FORK_REMOTE}.fetch`,
          `+refs/heads/contributor/*ix:refs/remotes/${FORK_REMOTE}/contributor/*ix`
        ],
        repoPath
      )
    }
    if (dependency === 'malformed-head') {
      await git(
        [
          'config',
          '--replace-all',
          `remote.${FORK_REMOTE}.fetch`,
          `+refs/heads/bad..head:refs/remotes/${FORK_REMOTE}/bad..head`
        ],
        repoPath
      )
    }
    if (dependency === 'mirror-policy') {
      await git(['config', `remote.${FORK_REMOTE}.mirror`, 'true'], repoPath)
    }
    if (dependency === 'overlap-policy') {
      await git(['remote', 'add', 'other-alias', forkPath], repoPath)
      await git(
        [
          'config',
          '--replace-all',
          'remote.other-alias.fetch',
          `+refs/heads/*:refs/remotes/${FORK_REMOTE}/*`
        ],
        repoPath
      )
    }
    const policyKeys: Record<string, string> = {
      pushurl: 'pushurl',
      'url-multivar': 'url',
      filter: 'partialclonefilter',
      receivepack: 'receivepack',
      'unknown-key': 'user-policy'
    }
    const policyKey = policyKeys[dependency]
    if (policyKey) {
      await git(
        [
          'config',
          '--add',
          `remote.${FORK_REMOTE}.${policyKey}`,
          dependency === 'filter' ? 'blob:none' : forkPath
        ],
        repoPath
      )
    }
    if (dependency === 'global-pushurl' || dependency === 'global-fetch') {
      await git(
        [
          'config',
          '--file',
          isolatedGitEnv.GIT_CONFIG_GLOBAL!,
          `remote.${FORK_REMOTE}.${dependency === 'global-fetch' ? 'fetch' : 'pushurl'}`,
          dependency === 'global-fetch' ? `+refs/heads/*:refs/remotes/${FORK_REMOTE}/*` : forkPath
        ],
        repoPath
      )
    }
    if (dependency === 'custom-base') {
      ref = 'refs/private/contributor/fix'
      await git(['update-ref', ref, oid.trim()], repoPath)
      meta.baseRef = ref
    }
    if (dependency === 'false-hint' || dependency === 'unknown-host') {
      meta.pushTarget = forkTarget({ remoteCreated: false })
      if (dependency === 'unknown-host') {
        meta.hostId = 'ssh:unserved'
      }
    }
    if (dependency === 'url-pushDefault') {
      await git(['config', 'remote.pushDefault', forkPath], repoPath)
    }
    if (dependency === 'pushDefault') {
      await git(['config', 'remote.pushDefault', FORK_REMOTE], repoPath)
    }
    if (
      [
        'pushremote',
        'remote/merge',
        'multiple-merges',
        'dot',
        'dot-absent',
        'branch.base'
      ].includes(dependency)
    ) {
      await git(['branch', 'Keeper'], repoPath)
      const key =
        dependency === 'pushremote'
          ? 'pushremote'
          : dependency === 'branch.base'
            ? 'base'
            : 'remote'
      await git(
        [
          'config',
          `branch.Keeper.${key}`,
          key === 'base' ? ref : dependency.startsWith('dot') ? '.' : FORK_REMOTE
        ],
        repoPath
      )
      await git(
        [
          'config',
          'branch.Keeper.merge',
          dependency.startsWith('dot') ? ref : 'refs/heads/contributor/fix'
        ],
        repoPath
      )
      if (dependency === 'multiple-merges') {
        await git(['config', '--add', 'branch.Keeper.merge', 'refs/heads/missing'], repoPath)
      }
      if (dependency === 'dot-absent') {
        await git(['update-ref', '-d', ref], repoPath)
      }
    }
    if (dependency === 'baseRef') {
      meta.baseRef = ref
    }
    if (dependency === 'sparseBaseRef') {
      meta.sparseBaseRef = ref
    }
    if (dependency === 'global-marker' || dependency === 'false-metadata') {
      await git(['config', '--local', '--unset', `remote.${FORK_REMOTE}.orca-created`], repoPath)
      if (dependency === 'global-marker') {
        await git(
          [
            'config',
            '--file',
            isolatedGitEnv.GIT_CONFIG_GLOBAL!,
            `remote.${FORK_REMOTE}.orca-created`,
            'true'
          ],
          repoPath
        )
      }
      meta.pushTarget = forkTarget()
    }
    const before = await git(['config', '--get-regexp', `^remote\\.${FORK_REMOTE}\\.`], repoPath)
    const store = { getAllWorktreeMeta: () => ({ [worktreeId('/saved')]: meta }) }
    const calls: string[][] = []
    const checked: GitRemoteExec = (args, cwd) => {
      calls.push(args)
      return execGit(args, cwd)
    }
    if (operation === 'cleanup') {
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        repoPath,
        worktreeId('/removed'),
        forkTarget(),
        store,
        checked
      )
    } else if (operation === 'sweep') {
      expect(
        await reconcileOrphanedPrRemotesWithExec(repoPath, REPO_ID, store, checked, async () => [
          '/saved'
        ])
      ).toEqual([])
    } else {
      await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, checked)
    }
    if (dependency === 'dot-absent') {
      await git(['update-ref', ref, oid.trim()], repoPath)
    }
    expect(await git(['rev-parse', ref], repoPath)).toBe(oid)
    if (dependency === 'malformed-head') {
      expect(await git(['config', `remote.${FORK_REMOTE}.url`], repoPath)).toBe(`${forkPath}\n`)
      expect(
        calls.some(
          (args) =>
            args.includes('remove') ||
            args.includes('--unset-all') ||
            args.includes('--add') ||
            args.some((value) => value.endsWith('.tagOpt')) ||
            args[0] === 'update-ref'
        )
      ).toBe(false)
    } else {
      expect(await git(['remote'], repoPath)).toContain(FORK_REMOTE)
    }
    if (dependency.startsWith('dot')) {
      expect(await git(['rev-parse', 'Keeper@{u}'], repoPath)).toBe(oid)
    }
    if (
      ![
        'remote/merge',
        'branch.base',
        'baseRef',
        'sparseBaseRef',
        'false-hint',
        'unknown-host',
        'dot',
        'dot-absent'
      ].includes(dependency)
    ) {
      expect(await git(['config', '--get-regexp', `^remote\\.${FORK_REMOTE}\\.`], repoPath)).toBe(
        before
      )
    }
  }
)

it.each(
  ['cleanup', 'sweep', 'migration'].flatMap((operation) =>
    (operation === 'sweep'
      ? ['policy', 'native', 'metadata', 'liveness']
      : ['policy', 'native', 'metadata']
    ).map((race) => ({ operation, race }))
  )
)(
  'aborts $operation when fresh $race changes its destructive plan',
  async ({ operation, race }) => {
    let configReads = 0,
      metadataReads = 0,
      livenessReads = 0
    const meta = mergeWorktreeMetaForWrite(undefined, {
      pushTarget: forkTarget({ remoteCreated: false }),
      hostId: race === 'liveness' ? undefined : 'ssh:late'
    })
    const store = {
      getAllWorktreeMeta: () => {
        metadataReads += 1
        return race === 'liveness' || (race === 'metadata' && configReads > 1)
          ? { [worktreeId('/late')]: meta }
          : {}
      }
    }
    const calls: string[][] = []
    const checked: GitRemoteExec = async (args, cwd) => {
      calls.push(args)
      if (args[0] === 'config' && args.includes('--show-origin') && ++configReads === 2) {
        if (race === 'policy') {
          await git(['config', `remote.${FORK_REMOTE}.receivepack`, 'user-receiver'], repoPath)
        }
        if (race === 'native') {
          await git(['branch', 'late'], repoPath)
          await git(['config', 'branch.late.remote', '.'], repoPath)
          await git(
            ['config', 'branch.late.merge', `refs/remotes/${FORK_REMOTE}/contributor/fix`],
            repoPath
          )
        }
      }
      return execGit(args, cwd)
    }
    const live = async () => {
      livenessReads += 1
      return race === 'liveness' && livenessReads > 1 ? ['/late'] : []
    }
    if (operation === 'cleanup') {
      await cleanupUnusedWorktreePushTargetRemoteWithExec(
        repoPath,
        worktreeId('/removed'),
        forkTarget(),
        store,
        checked
      )
    } else if (operation === 'sweep') {
      expect(
        await reconcileOrphanedPrRemotesWithExec(repoPath, REPO_ID, store, checked, live)
      ).toEqual([])
    } else {
      expect(await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, checked)).toEqual([])
    }
    expect(configReads).toBe(2)
    expect(
      calls.some(
        (args) =>
          args.includes('remove') ||
          args.includes('--unset-all') ||
          args.includes('--add') ||
          args.some((value) => value.endsWith('.tagOpt')) ||
          args[0] === 'update-ref'
      )
    ).toBe(false)
    expect(await git(['remote'], repoPath)).toContain(FORK_REMOTE)
  }
)

it('keeps desired stock state local and releases a dot dependency for later positive cleanup', async () => {
  const ref = `refs/remotes/${FORK_REMOTE}/contributor/fix`
  await git(
    [
      'config',
      '--replace-all',
      `remote.${FORK_REMOTE}.fetch`,
      `+refs/heads/contributor/fix*:refs/remotes/${FORK_REMOTE}/contributor/fix*`
    ],
    repoPath
  )
  const calls: string[][] = []
  const run: GitRemoteExec = (args, cwd) => {
    calls.push(args)
    return execGit(args, cwd)
  }
  const store = {
    getAllWorktreeMeta: () => ({
      [worktreeId('/saved')]: mergeWorktreeMetaForWrite(undefined, {
        pushTarget: forkTarget({ remoteCreated: false })
      })
    })
  }
  expect(await migrateForkRemoteRefspecsWithExec(repoPath, REPO_ID, store, run)).toEqual([])
  expect(calls).toHaveLength(7)
  const branch = (await git(['branch', '--show-current'], repoPath)).trim()
  await git(['config', `branch.${branch}.remote`, '.'], repoPath)
  await git(['config', `branch.${branch}.merge`, ref], repoPath)
  await cleanupUnusedWorktreePushTargetRemoteWithExec(
    repoPath,
    worktreeId('/removed'),
    forkTarget(),
    storeOf({}),
    execGit
  )
  expect(await git(['rev-parse', 'HEAD@{u}'], repoPath)).toBe(
    await git(['rev-parse', ref], repoPath)
  )
  await git(['config', '--remove-section', `branch.${branch}`], repoPath)
  calls.length = 0
  await cleanupUnusedWorktreePushTargetRemoteWithExec(
    repoPath,
    worktreeId('/removed'),
    forkTarget(),
    storeOf({}),
    run
  )
  expect(await git(['remote'], repoPath)).not.toContain(FORK_REMOTE)
  expect(calls.filter((args) => args.includes('-v'))).toHaveLength(2)
  expect(calls.some((args) => args.includes('get-url'))).toBe(false)
})
