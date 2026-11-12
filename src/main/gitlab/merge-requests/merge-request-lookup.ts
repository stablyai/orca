import { getReviewBranchSource } from '../../github/client/lookup/tracked-upstream-branch'
import { createGitLabBranchDiscovery } from './branch-review-discovery'
import { resolveReviewSourceProject } from './branch-review-source'
import { forgetReviewProjectIdentity } from './review-project-identity'
import { mergedMRContainsHead, forgetMergedMRCommitMembership } from './merged-mr-commit-membership'
import { readCurrentReviewHead } from '../../source-control/review-current-head'
import { shouldHideMergedImplicitReview } from '../../source-control/branch-review-selection'
import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName,
  shouldHideNonOpenReviewOnDefaultBranch
} from '../../source-control/repo-default-branch'
import { extractExecError } from '../../git/command-runner/process-capture/exec-error'
import { classifyGlabError } from '../requests/glab-error-classification'
import type { MRInfo } from '../../../shared/gitlab-types'
import { derivePipelineStatus, mapMRInfo } from '../requests/gitlab-response-mapping'
import { acquire, release } from '../requests/glab-request-admission'
import { getGlabKnownHosts } from '../projects/gitlab-known-host-probe'
import {
  getProjectRef,
  glabHostnameArgs,
  glabRepoExecOptions
} from '../projects/gitlab-project-ref-resolution'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import type { ProjectRef } from '../projects/project-ref-parser'
import { encodedProject } from '../projects/project-path-encoding'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../source-control/hosted-review-git-options'

type BranchReviewOptions = HostedReviewExecutionOptions & {
  currentHeadOid?: string | null
  userRefresh?: boolean
}

type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [getHostedReviewLocalGitOptions(options)] : []
}

export async function getProjectSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<ProjectRef | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const knownHosts = await getGlabKnownHosts(connectionId, localGitArgs[0])
  return getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
}

/** Failures and confirmed absence return null. */
export async function getMergeRequest(
  repoPath: string,
  iid: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<MRInfo | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
  await acquire()
  try {
    const args = projectRef
      ? [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        ]
      : ['mr', 'view', String(iid), '--output', 'json']
    const { stdout } = await glabExecFileAsync(
      args,
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
      pipeline?: { status?: string } | null
    }
    // glab serializes GitLab's null changes_count as ''.
    if (data.changes_count === '') {
      data.changes_count = null
    }
    // Why: older GitLab instances expose `pipeline` instead of `head_pipeline`; try both.
    const pipelineStatus = derivePipelineStatus(data.head_pipeline ?? data.pipeline ?? null)
    return mapMRInfo(data, pipelineStatus)
  } catch {
    return null
  } finally {
    release()
  }
}

export async function getMergeRequestForBranch(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: BranchReviewOptions = {},
  // Strict callers need failures distinguished from confirmed missing reviews.
  throwOnFailure = false
): Promise<MRInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedMRIid == null) {
    return null
  }
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
  if (!projectRef) {
    return null
  }
  await acquire()
  let membershipTargetId: number | undefined
  try {
    const fetchByIid = async (iid: number) => {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}?with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const raw: Parameters<typeof mapMRInfo>[0] & {
        target_project_id?: number
        project_id?: number
        source_project_id?: number
        source_branch?: string
        diff_refs?: unknown
      } = JSON.parse(stdout)
      return {
        raw,
        info: mapMRInfo(raw, derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null))
      }
    }
    if (typeof linkedMRIid === 'number') {
      return (await fetchByIid(linkedMRIid)).info
    }
    const source = await getReviewBranchSource(
      repoPath,
      branchName,
      connectionId,
      localGitOptions,
      options.userRefresh
    )
    const readDefaultBranch = () =>
      source.remoteName === 'origin'
        ? getRepoDefaultBranchName(repoPath, connectionId, localGitOptions)
        : getRemoteHeadBranchName(repoPath, source.remoteName, connectionId, localGitOptions)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const identityArgs = {
        repoPath,
        target: projectRef,
        urls: source.urls,
        connectionId,
        localGitOptions,
        force: options.userRefresh || attempt > 0
      }
      const sourceProject = await resolveReviewSourceProject(identityArgs)
      try {
        const discover = createGitLabBranchDiscovery({
          repoPath,
          project: projectRef,
          sourceProjectId: sourceProject.id,
          connectionId,
          localGitOptions
        })
        let candidate = await discover(source.branchName)
        let usedTrackedName = false
        if (!candidate && source.trackedBranchName && source.trackedUrls) {
          const trackedSource = await resolveReviewSourceProject({
            ...identityArgs,
            urls: source.trackedUrls
          })
          const defaultBranch = await readDefaultBranch()
          const provenDefault =
            trackedSource.project.path === projectRef.path &&
            source.trackedBranchName === defaultBranch
          if (trackedSource.id === sourceProject.id && !provenDefault) {
            candidate = await discover(source.trackedBranchName)
            usedTrackedName = true
          }
        }
        if (!candidate) {
          return null
        }
        if (usedTrackedName && candidate.source_project_id === candidate.target_project_id) {
          const defaultBranch = await readDefaultBranch()
          if (candidate.source_branch === defaultBranch) {
            return null
          }
        }
        membershipTargetId = candidate.target_project_id
        const { info, raw } = await fetchByIid(candidate.iid)
        if (
          info.number !== candidate.iid ||
          raw.source_project_id !== candidate.source_project_id ||
          raw.target_project_id !== candidate.target_project_id ||
          raw.source_branch !== candidate.source_branch
        ) {
          throw new Error('GitLab merge request identity changed during lookup')
        }
        if (info.state === 'merged') {
          const currentHead =
            options.currentHeadOid?.trim() ||
            (await readCurrentReviewHead(repoPath, connectionId, localGitOptions))
          if (shouldHideMergedImplicitReview(info.state, linkedMRIid, info.headSha, currentHead)) {
            if (!currentHead) {
              return null
            }
            const targetProjectId = raw.target_project_id ?? raw.project_id
            if (
              !Number.isSafeInteger(targetProjectId) ||
              !targetProjectId ||
              targetProjectId <= 0
            ) {
              throw new Error('Invalid GitLab target project identity')
            }
            if (
              (await mergedMRContainsHead({
                repoPath,
                project: projectRef,
                targetProjectId,
                iid: info.number,
                headOid: currentHead,
                revisionHeadSha: info.headSha,
                diffRefs: raw.diff_refs,
                connectionId,
                localGitOptions,
                userRefresh: options.userRefresh
              })) !== 'contained'
            ) {
              return null
            }
          }
        }
        if (
          !(await shouldHideNonOpenReviewOnDefaultBranch({
            state: info.state,
            reviewNumber: info.number,
            branchName,
            repoPath,
            connectionId,
            localGitOptions
          }))
        ) {
          return info
        }
        return null
      } catch (error) {
        const detail = extractExecError(error)
        if (
          attempt > 0 ||
          classifyGlabError(
            [detail.stderr, detail.stdout, error instanceof Error ? error.message : ''].join('\n')
          ).type !== 'not_found'
        ) {
          throw error
        }
        forgetReviewProjectIdentity(repoPath, sourceProject.project, connectionId, localGitOptions)
      }
    }
    return null
  } catch (error) {
    const detail = extractExecError(error)
    const kind = classifyGlabError(
      [detail.stderr, detail.stdout, error instanceof Error ? error.message : ''].join('\n')
    ).type
    if (
      kind === 'not_found' ||
      kind === 'permission_denied' ||
      /HTTP\s+401|unauthorized/i.test(
        [detail.stderr, detail.stdout, error instanceof Error ? error.message : ''].join('\n')
      )
    ) {
      if (membershipTargetId !== undefined) {
        forgetMergedMRCommitMembership({
          targetProjectId: membershipTargetId,
          repoPath,
          project: projectRef,
          connectionId,
          localGitOptions
        })
      }
    }
    if (throwOnFailure) {
      throw error
    }
    return null
  } finally {
    release()
  }
}

/** Preserve lookup failures as unavailable rather than confirmed missing reviews. */
export function getMergeRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: BranchReviewOptions = {}
): Promise<MRInfo | null> {
  return getMergeRequestForBranch(repoPath, branch, linkedMRIid, connectionId, options, true)
}
