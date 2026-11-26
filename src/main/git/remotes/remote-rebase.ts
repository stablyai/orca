import { randomUUID } from 'node:crypto'
import { normalizeGitErrorMessage } from '../../../shared/git/remotes/git-remote-error'
import { isNoWriteFetchHeadUnsupportedError } from '../../../shared/git/fetch/git-fetch-head-capability'
import { runWithGitWorktreeOperationLock } from '../../../shared/git/worktrees/git-worktree-operation-lock'
import {
  REBASE_SOURCE_FETCH_TIMEOUT_MS,
  resolveGitRemoteRebaseSource
} from '../../../shared/git/remotes/git-rebase-source'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../command-runner/git-runtime-options'
import { withLocalGitCapabilityCacheForExecution } from '../command-runner/host-routing/git-capability-state'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../source-control/git-read-cache-invalidation'
import {
  AUTOSTASH_REAPPLY_CONFLICT,
  detectConflictOperation
} from '../source-control/mutations/git-conflict-operation'
import { recordOrcaRebaseProvenance } from '../source-control/mutations/orca-rebase-provenance'
import {
  readRebaseRunFiles,
  readRebaseRunIdentity,
  readRebaseStopToken,
  readRebasingBranch
} from '../source-control/mutations/rebase-continue'
import type { RebaseFromBaseResult } from '../../../shared/git/status/git-status-types'
import { addWslEnvKeys } from '../../../shared/shell/wsl/wsl-env'
import { headMovedOnlyByRebaseRun, newOrcaRebaseReflogAction } from './orca-rebase-reflog'

export async function gitPullRebaseFromBase(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<RebaseFromBaseResult> {
  return runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
    gitPullRebaseFromBaseUnlocked(worktreePath, baseRef, options)
  )
}

async function gitPullRebaseFromBaseUnlocked(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions
): Promise<RebaseFromBaseResult> {
  return runWithGitReadCacheInvalidation(async () => {
    const operationOptions = {
      ...gitOptionsForWorktree(worktreePath, options),
      terminationBarrier: true
    }
    let rebaseRef: string | null = null
    let integratedUpstreamOid: string | null = null
    // What this run will write as onto/orig-head, so a paused rebase can be proven to be ours.
    let ownRun: { onto: string; origHead: string } | null = null
    // A rebase directory that already existed was not created by this run.
    let rebaseDirAbsentBeforeSpawn = false
    const reflogAction = newOrcaRebaseReflogAction()
    try {
      const source = await resolveGitRemoteRebaseSource(
        (args) => gitExecFileAsync(args, operationOptions),
        baseRef
      )
      let forkPoint: string | null = null
      let hasHead = true
      try {
        const { stdout } = await gitExecFileAsync(
          ['merge-base', '--fork-point', `refs/remotes/${source.displayName}`, 'HEAD'],
          operationOptions
        )
        forkPoint = stdout.trim() || null
      } catch {
        // A first fetch or an unhelpful reflog falls back to Git's merge-base behavior.
        try {
          await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], operationOptions)
        } catch {
          hasHead = false
        }
      }
      // Why: concurrent fetches can replace FETCH_HEAD and remote-tracking refs between fetch and rebase.
      rebaseRef = `refs/orca/rebase/${randomUUID()}`
      const fetchArgs = [
        source.remoteName,
        `+refs/heads/${source.branchName}:${rebaseRef}`,
        `+refs/heads/${source.branchName}:refs/remotes/${source.displayName}`
      ]
      await withLocalGitCapabilityCacheForExecution(
        { cwd: worktreePath, ...options },
        (capabilities) =>
          capabilities.runWithFallback(
            'fetch-no-write-fetch-head',
            () =>
              gitExecFileAsync(['fetch', '--no-write-fetch-head', ...fetchArgs], {
                ...operationOptions,
                timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS
              }),
            () =>
              gitExecFileAsync(['fetch', ...fetchArgs], {
                ...operationOptions,
                timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS
              }),
            isNoWriteFetchHeadUnsupportedError
          )
      )
      // Pull hiding is only safe when the upstream tip is already in the branch being rebased.
      integratedUpstreamOid = hasHead ? await readIntegratedUpstreamOid(operationOptions) : null
      ownRun = integratedUpstreamOid ? await readOwnRunIdentity(rebaseRef, operationOptions) : null
      rebaseDirAbsentBeforeSpawn = (await readRebaseRunIdentity(worktreePath, options)) === null
      const { stdout, stderr } = await gitExecFileAsync(
        hasHead
          ? forkPoint
            ? ['rebase', '--onto', rebaseRef, forkPoint]
            : ['rebase', rebaseRef]
          : ['merge', '--ff-only', rebaseRef],
        { ...operationOptions, env: reflogActionEnv(reflogAction) }
      )
      // rebase.autoStash can land the rebase yet leave the reapplied edits conflicted.
      return {
        autostashConflict: AUTOSTASH_REAPPLY_CONFLICT.test(`${stdout}\n${stderr}`),
        ...(integratedUpstreamOid ? { integratedUpstreamOid } : {})
      }
    } catch (error) {
      if (integratedUpstreamOid && ownRun && rebaseDirAbsentBeforeSpawn) {
        await rememberPausedOrcaRebase(
          worktreePath,
          integratedUpstreamOid,
          ownRun,
          reflogAction,
          options
        )
      }
      throw new Error(normalizeGitErrorMessage(error, 'pull'), { cause: error })
    } finally {
      if (rebaseRef) {
        try {
          const { signal: _abortedSignal, ...cleanupOptions } = gitOptionsForWorktree(
            worktreePath,
            options
          )
          await gitExecFileAsync(['update-ref', '-d', rebaseRef], cleanupOptions)
        } catch {
          // Cleanup must not hide the fetch or rebase result.
        }
      }
    }
  })
}

async function readOwnRunIdentity(
  rebaseRef: string,
  options: Parameters<typeof gitExecFileAsync>[1]
): Promise<{ onto: string; origHead: string } | null> {
  try {
    const onto = (
      await gitExecFileAsync(['rev-parse', '--verify', rebaseRef], options)
    ).stdout.trim()
    const origHead = (
      await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], options)
    ).stdout.trim()
    return onto && origHead ? { onto, origHead } : null
  } catch {
    return null
  }
}

/** The upstream tip, only when it is an ancestor of HEAD (no unintegrated collaborator commits). */
async function readIntegratedUpstreamOid(
  options: Parameters<typeof gitExecFileAsync>[1]
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '-q', '--verify', '@{upstream}'],
      options
    )
    const upstreamOid = stdout.trim()
    if (!upstreamOid) {
      return null
    }
    await gitExecFileAsync(['merge-base', '--is-ancestor', upstreamOid, 'HEAD'], options)
    return upstreamOid
  } catch {
    return null
  }
}

function reflogActionEnv(reflogAction: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_REFLOG_ACTION: reflogAction }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_REFLOG_ACTION'])
  }
  return env
}

// A conflict stop keeps the proof with the run this spawn created: no rebase directory before it,
// and every HEAD move since its start tagged with this spawn's reflog action. The proof is keyed by
// the directory identity observed before that check, so only that run's Continue can claim it.
async function rememberPausedOrcaRebase(
  worktreePath: string,
  integratedUpstreamOid: string,
  ownRun: { onto: string; origHead: string },
  reflogAction: string,
  options: GitRuntimeOptions
): Promise<void> {
  try {
    const { signal: _abortedSignal, ...readOptions } = options
    if ((await detectConflictOperation(worktreePath, readOptions)) !== 'rebase') {
      return
    }
    // Captured before the reflog proof, so a run replaced after that check cannot inherit it.
    const observed = await readRebaseRunIdentity(worktreePath, readOptions)
    if (!observed) {
      return
    }
    if (
      !(await headMovedOnlyByRebaseRun(
        reflogAction,
        gitOptionsForWorktree(worktreePath, readOptions)
      ))
    ) {
      return
    }
    // Another Git may have replaced our paused run; only a run with our onto and orig-head is ours.
    const run = await readRebaseRunFiles(worktreePath, readOptions)
    if (run.onto !== ownRun.onto || run.origHead !== ownRun.origHead) {
      return
    }
    const branch = await readRebasingBranch(worktreePath, readOptions)
    const { incarnation } = await readRebaseStopToken(worktreePath, readOptions)
    if (branch && incarnation?.startsWith(`${observed}:`)) {
      recordOrcaRebaseProvenance(worktreePath, { branch, integratedUpstreamOid, incarnation })
    }
  } catch {
    // Missing proof only keeps Pull and Sync offered.
  }
}
