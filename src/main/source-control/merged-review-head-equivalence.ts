import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../git/command-runner/git-exec-file'
import { gitOptionsForWorktree } from '../git/command-runner/git-runtime-options'
import { createLocalGitObjectQuarantine } from '../git/objects/local-git-object-quarantine'
import type { GitExecutionContext } from '../git/command-runner/host-routing/wsl-git-path-preparation'
import { withLocalGitCapabilityCacheForExecution } from '../git/command-runner/host-routing/git-capability-state'
import { isUnsupportedMergeTreeWriteTreeError } from '../../shared/git/branches/git-merge-tree-capability'
import { MergedReviewMembershipMemo } from './merged-review-membership-memo'
import type { HostedReviewLocalGitOptions } from './hosted-review-git-options'

type Proof = 'equivalent' | 'unproven'

const BASE_REMOTES = ['origin', 'upstream']
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
// A fetch can make an unproven result provable without changing any commit IDs.
const proofMemo = new MergedReviewMembershipMemo<Proof>({
  weight: () => 1,
  maxWeight: 200,
  ttl: (proof) => (proof === 'equivalent' ? 6 * 60 * 60_000 : 0)
})

/**
 * True when HEAD is a remote base commit plus exactly the merged review's changes (an equivalent
 * rebase), so the workspace holds no work beyond the merged review. Unprovable cases return false.
 */
export async function mergedReviewHeadIsEquivalent(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
  reviewHeadOid: string | undefined
  baseBranchName: string | undefined
  headOid: string
}): Promise<boolean> {
  const reviewHead = args.reviewHeadOid?.trim().toLowerCase() ?? ''
  const head = args.headOid.trim().toLowerCase()
  const baseBranch = args.baseBranchName?.trim() ?? ''
  // SSH repo paths live on the remote host, which runs its own lookup with local Git.
  if (
    args.connectionId ||
    !GIT_OBJECT_ID.test(reviewHead) ||
    !GIT_OBJECT_ID.test(head) ||
    reviewHead === head ||
    !baseBranch ||
    baseBranch.startsWith('-')
  ) {
    return false
  }
  try {
    const gitOptions = {
      ...gitOptionsForWorktree(args.repoPath, args.localGitOptions),
      timeout: 10_000
    }
    // Missing review objects may arrive on the next fetch; do not retain that inconclusive result.
    await gitExecFileAsync(['cat-file', '-e', `${reviewHead}^{commit}`], gitOptions)
    const baseTips: string[] = []
    for (const remote of BASE_REMOTES) {
      try {
        const { stdout } = await gitExecFileAsync(
          ['rev-parse', '--verify', `refs/remotes/${remote}/${baseBranch}^{commit}`],
          gitOptions
        )
        const tip = stdout.trim()
        if (GIT_OBJECT_ID.test(tip)) {
          baseTips.push(tip)
        }
      } catch {
        // Missing remote bases cannot establish equivalence.
      }
    }
    const key = JSON.stringify([
      args.localGitOptions.wslDistro ?? null,
      args.repoPath,
      baseTips,
      reviewHead,
      head
    ])
    const proof = await proofMemo.read(key, async () => {
      try {
        return await proveEquivalence(
          args.repoPath,
          args.localGitOptions,
          reviewHead,
          baseTips,
          head
        )
      } catch {
        return 'unproven'
      }
    })
    return proof === 'equivalent'
  } catch {
    return false
  }
}

async function proveEquivalence(
  repoPath: string,
  localGitOptions: HostedReviewLocalGitOptions,
  reviewHead: string,
  baseTips: string[],
  head: string
): Promise<Proof> {
  const gitOptions = { ...gitOptionsForWorktree(repoPath, localGitOptions), timeout: 10_000 }
  const read = async (argv: string[]) => (await gitExecFileAsync(argv, gitOptions)).stdout.trim()
  const headTree = await read(['rev-parse', '--verify', `${head}^{tree}`])
  for (const baseTip of baseTips) {
    let base: string
    try {
      base = await read(['merge-base', head, baseTip])
    } catch {
      continue
    }
    // A base with HEAD's tree means HEAD adds nothing itself, e.g. a reused branch name at main.
    if (!GIT_OBJECT_ID.test(base) || (await read(['rev-parse', `${base}^{tree}`])) === headTree) {
      continue
    }
    const proven = await withLocalGitCapabilityCacheForExecution(
      { cwd: repoPath, wslDistro: localGitOptions.wslDistro },
      (capabilities) =>
        capabilities.runWithFallback(
          'merge-tree-write-tree',
          async () => {
            const run = (
              env: NodeJS.ProcessEnv | undefined,
              quarantineCanStart?: (context?: GitExecutionContext) => boolean
            ) =>
              gitExecFileAsync(['merge-tree', '--write-tree', base, reviewHead], {
                ...gitOptions,
                ...(env ? { env } : {}),
                canStart: quarantineCanStart
              })
            try {
              // Quarantine the throwaway merged tree; probe support before older Git sees a quarantine.
              const { stdout } = capabilities.isKnownSupported('merge-tree-write-tree')
                ? await createLocalGitObjectQuarantine(repoPath, localGitOptions).run(run)
                : await run(undefined)
              return stdout.split('\n', 1)[0].trim() === headTree
            } catch (error) {
              if (isUnsupportedMergeTreeWriteTreeError(error)) {
                throw error
              }
              // Conflicts and missing review objects cannot prove equivalence.
              return false
            }
          },
          // Git < 2.38: exact per-path mode/blob transitions only match when base never touched them.
          async () => {
            const reviewBase = await read(['merge-base', reviewHead, base])
            const delta = async (from: string, to: string) =>
              (
                await gitExecFileAsyncBuffer(
                  ['diff-tree', '-r', '-z', '--no-abbrev', '--no-renames', from, to],
                  gitOptions
                )
              ).stdout
            const [reviewDelta, headDelta] = await Promise.all([
              delta(reviewBase, reviewHead),
              delta(base, head)
            ])
            return reviewDelta.length > 0 && reviewDelta.equals(headDelta)
          },
          isUnsupportedMergeTreeWriteTreeError
        )
    )
    if (proven) {
      return 'equivalent'
    }
  }
  return 'unproven'
}
