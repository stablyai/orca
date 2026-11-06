import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readGitAdminFile,
  resolveGitCommonDirectory
} from '../../shared/git/metadata/git-common-directory'
import { isBranchReservedByWorktreeOperation } from '../../shared/git/worktrees/git-worktree-admin'
import { probeExactRefs } from './exact-ref-probe'
import { gitExecFileAsync } from './command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from './source-control/git-read-cache-invalidation'
import { readRepoCommonDirFromGit } from './worktrees/catalog/worktree-list-reader'
import {
  areWorktreePathsEqual,
  translateWorktreePath
} from './worktrees/catalog/worktree-path-comparison'
import { listWorktreesStrict } from './worktrees/catalog/worktree-listing'
import {
  forceDeleteLocalBranch,
  runWithLocalBranchCleanup
} from './worktrees/removal/worktree-branch-removal'
import { gitExecOptions, type GitWorktreeExecOptions } from './worktrees/worktree-operation-options'

export type StandaloneBranchDeletion = {
  ref: string
  expectedOid: string
  anchorRef: string
  anchorOid: string
}

export async function deleteStandaloneBranch(
  repoPath: string,
  request: StandaloneBranchDeletion,
  options: GitWorktreeExecOptions = {},
  protectedBaseRef?: string
): Promise<{ deleted: true; ref: string; oid: string; anchorRef: string; anchorOid: string }> {
  if (
    [
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_NAMESPACE',
      'GIT_SHALLOW_FILE',
      'GIT_GRAFT_FILE',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS'
    ].some((key) => process.env[key] !== undefined)
  ) {
    throw new Error('Cannot verify repository identity with inherited Git repository overrides.')
  }
  const { ref, expectedOid, anchorRef, anchorOid } = request
  const branch = ref.slice('refs/heads/'.length)
  const anchor = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(anchorRef)
  if (
    !ref.startsWith('refs/heads/') ||
    !branch ||
    !anchor ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedOid) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(anchorOid)
  ) {
    throw new Error('Invalid full local ref, remote integration anchor, or full OID.')
  }
  const runGit = (args: string[], cwd = repoPath, stdin?: string) =>
    gitExecFileAsync(args, {
      ...gitExecOptions(cwd, options),
      ...(stdin ? { stdin } : {})
    })
  await runGit(['check-ref-format', ref])
  await runGit(['check-ref-format', anchorRef])
  const commonDir = await resolveGitCommonDirectory(repoPath, options)
  if (!commonDir) {
    throw new Error('Cannot verify repository identity.')
  }
  return runWithLocalBranchCleanup(repoPath, options, () =>
    runWithGitReadCacheInvalidation(async () => {
      const gitCommonDir = await readRepoCommonDirFromGit(repoPath, options)
      if (
        !gitCommonDir ||
        !areWorktreePathsEqual(
          await realpath(commonDir),
          await realpath(translateWorktreePath(gitCommonDir, repoPath, options))
        )
      ) {
        throw new Error('Git execution does not identify the registered repository.')
      }
      const { stdout: shallow } = await runGit(['rev-parse', '--is-shallow-repository'])
      if (
        shallow.trim() !== 'false' ||
        (await readGitAdminFile(join(commonDir, 'info', 'grafts'), options.signal))?.trim()
      ) {
        throw new Error('Cannot prove integration with shallow or grafted history.')
      }
      const remote = anchor[1]
      const defaultBranch = anchor[2]
      const { stdout: remoteUrl } = await runGit(['config', '--get-all', `remote.${remote}.url`])
      const { stdout: defaultRef } = await runGit(['symbolic-ref', `refs/remotes/${remote}/HEAD`])
      if (
        remoteUrl.trim().split('\n').length !== 1 ||
        !remoteUrl.trim() ||
        defaultRef.trim() !== anchorRef
      ) {
        throw new Error('Cannot verify integration anchor as the source remote default branch.')
      }
      const sameBranch = (candidate: string | undefined) =>
        candidate?.toLowerCase() === branch.toLowerCase()
      if (
        sameBranch(defaultBranch) ||
        /^(main|master|trunk|develop|development|HEAD)$/i.test(branch) ||
        sameBranch(protectedBaseRef) ||
        protectedBaseRef?.toLowerCase() === ref.toLowerCase()
      ) {
        throw new Error('Default or reserved branches cannot be deleted.')
      }
      const { stdout: remoteList } = await runGit(['remote'])
      const remotes = remoteList.trim().split('\n')
      if (!remotes.includes(remote) || remotes.length > 32) {
        throw new Error('Cannot completely verify repository default branches.')
      }
      for (const source of remotes) {
        const { stdout: sourceDefault } = await runGit([
          'symbolic-ref',
          `refs/remotes/${source}/HEAD`
        ])
        const prefix = `refs/remotes/${source}/`
        if (!sourceDefault.trim().startsWith(prefix)) {
          throw new Error('Cannot verify a source remote default branch.')
        }
        if (
          sameBranch(sourceDefault.trim().slice(prefix.length)) ||
          protectedBaseRef?.toLowerCase() === `${source}/${branch}`.toLowerCase() ||
          protectedBaseRef?.toLowerCase() === `refs/remotes/${source}/${branch}`.toLowerCase()
        ) {
          throw new Error('Remote default branches cannot be deleted.')
        }
      }
      const { stdout: resolvedAnchor } = await runGit([
        'rev-parse',
        '--symbolic-full-name',
        anchorRef
      ])
      if (resolvedAnchor.trim() !== anchorRef) {
        throw new Error('Symbolic integration anchors cannot be used.')
      }
      const { stdout: resolvedRef } = await runGit(['rev-parse', '--symbolic-full-name', ref])
      if (resolvedRef.trim() !== ref) {
        throw new Error('Symbolic local branch refs cannot be deleted.')
      }
      const { stdout: head } = await runGit(['rev-parse', '--verify', `${ref}^{commit}`])
      const { stdout: integration } = await runGit([
        'rev-parse',
        '--verify',
        `${anchorRef}^{commit}`
      ])
      if (head.trim() !== expectedOid || integration.trim() !== anchorOid) {
        throw new Error('Branch or integration anchor changed; obtain fresh evidence.')
      }
      await runGit(['--no-replace-objects', 'merge-base', '--is-ancestor', expectedOid, anchorOid])
      const worktrees = await listWorktreesStrict(repoPath, {
        ...options,
        includeCreatePreparations: true
      })
      if (
        !worktrees.length ||
        (await isBranchReservedByWorktreeOperation(repoPath, branch, worktrees, options))
      ) {
        throw new Error('Cannot verify branch is free of worktree operation reservations.')
      }
      await forceDeleteLocalBranch(repoPath, branch, expectedOid, runGit, {
        ...options,
        integrationAnchor: { ref: anchorRef, oid: anchorOid }
      })
      const presence = await probeExactRefs((args) => runGit(args), [ref])
      if (!presence.absentRefs.includes(ref)) {
        throw new Error(
          'Cannot confirm branch absence after deletion; re-inventory before retrying.'
        )
      }
      return { deleted: true, ref, oid: expectedOid, anchorRef, anchorOid }
    })
  )
}
