import type { RpcOperationSender } from '../transport/rpc/rpc-operation-sender'
import type { MobileRuntimeRepoSummary } from './agent-launch/mobile-runtime-repo-operations'
import { isFolderRepo } from '../../../src/shared/repo-kind'
import { gitRebaseVerdictRead } from '../source-control/mobile-git-read-operations'
import { translate } from '../i18n/mobile-i18n'
import { workspaceKindForWorktreeId } from '../../../src/shared/workspace-launch-kind'

export type MobileReviewActionAdmission = { ok: true } | { ok: false; message: string }

/**
 * The desktop rule at the phone's review-action boundary: a fresh verdict from the host that owns
 * the workspace, read at launch time; cached workspace state may still say attached.
 */
export async function confirmNoRebaseBeforeMobileReviewAction(
  client: RpcOperationSender,
  worktreeId: string,
  /** The repo the launch resolved for this workspace (host ambiguity already settled). */
  repo: Pick<MobileRuntimeRepoSummary, 'kind'> | null
): Promise<MobileReviewActionAdmission> {
  // Folders, native or repo-backed, run no Git operation, so their review launches are unchanged.
  if (workspaceKindForWorktreeId(worktreeId) !== 'git-worktree' || (repo && isFolderRepo(repo))) {
    return { ok: true }
  }
  let verdict: 'active' | 'none' | 'unverifiable' | undefined
  try {
    const reply = await gitRebaseVerdictRead.request(client, {
      worktree: `id:${worktreeId}`,
      admissionTier: 'interactive',
      includeLineStats: false,
      verifyRebaseOperation: true
    })
    verdict = gitRebaseVerdictRead.interpret(reply).rebaseOperation
    if (verdict === undefined) {
      return {
        ok: false,
        message: translate(
          'session.reviewActionRebaseCheck.hostOutdated',
          'Update Orca on your computer to start this action; it cannot report whether a rebase is in progress.'
        )
      }
    }
  } catch {
    verdict = 'unverifiable'
  }
  if (verdict === 'none') {
    return { ok: true }
  }
  return {
    ok: false,
    message:
      verdict === 'active'
        ? translate(
            'session.reviewActionRebaseCheck.active',
            'A rebase is in progress in this workspace. Continue or abort it before starting this action.'
          )
        : translate(
            'session.reviewActionRebaseCheck.unverifiable',
            'Could not verify that no rebase is in progress in this workspace, so the action was not started.'
          )
  }
}
