import type { IssueSourcePreference } from '../../shared/repo-types'
import { invalidateGiteaPullRequestScanForRepo } from './client'
import { requestGiteaJson } from './gitea-json-request'
import { applyGiteaPullRequestLabelChanges } from './pull-request-label-edit'
import type { RawGiteaPullRequest } from './pull-request-mappers'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  giteaWriteUsesTea,
  resolveGiteaMutationRepo,
  runGiteaTeaCommand,
  teaPullCommand,
  writeGiteaJson,
  type GiteaMutationFailure,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

export type GiteaPRUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  /** True marks the pull request draft; false marks it ready for review. */
  draft?: boolean
}

export type { GiteaPRReviewersUpdateResult } from './pull-request-reviewer-update'
export { updateGiteaPRReviewers } from './pull-request-reviewer-update'

const DRAFT_PREFIX = /^(?:wip:\s*|\[wip\]\s*|draft:\s*)/i

type ResolvedPull = { repo: GiteaRepoRef; indexArg: string }

function canWrite(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() !== null || Boolean(repo.loginName)
}

function cleanNames(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)
}

function stripGiteaDraftPrefix(title: string): string {
  let current = title
  while (DRAFT_PREFIX.test(current)) {
    current = current.replace(DRAFT_PREFIX, '')
  }
  return current
}

function applyGiteaDraftTitle(title: string, draft: boolean): string {
  if (!draft) {
    return stripGiteaDraftPrefix(title)
  }
  return DRAFT_PREFIX.test(title) ? title : `WIP: ${title}`
}

function pullTitle(raw: RawGiteaPullRequest): string | null {
  return typeof raw.title === 'string' ? raw.title : null
}

async function resolvePull(
  repoPath: string,
  index: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedPull | GiteaMutationFailure> {
  const indexArg = giteaPullIndexArg(index)
  if (!indexArg) {
    return { ok: false, error: 'Pull request index must be a positive integer.' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: 'No Gitea repository found for this repository.' }
  }
  if (!canWrite(repo)) {
    return giteaAuthRequiredResult()
  }
  return { repo, indexArg }
}

function isResolvedPull(value: ResolvedPull | GiteaMutationResult): value is ResolvedPull {
  return 'repo' in value
}

function pullPath(repo: GiteaRepoRef, indexArg: string): string {
  return `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}`
}

async function readPullRequest(
  repo: GiteaRepoRef,
  indexArg: string
): Promise<RawGiteaPullRequest | null> {
  return requestGiteaJson<RawGiteaPullRequest>(repo, pullPath(repo, indexArg), {}, true)
}

function hasMetadataChange(updates: GiteaPRUpdate): boolean {
  return (
    updates.title !== undefined ||
    updates.body !== undefined ||
    updates.draft !== undefined ||
    cleanNames(updates.addLabels).length > 0 ||
    cleanNames(updates.removeLabels).length > 0
  )
}

async function resolveEditedTitle(
  repo: GiteaRepoRef,
  indexArg: string,
  updates: GiteaPRUpdate
): Promise<{ ok: true; title: string | undefined } | GiteaMutationFailure> {
  if (updates.draft === undefined) {
    return { ok: true, title: updates.title }
  }
  const source =
    updates.title !== undefined
      ? updates.title
      : pullTitle((await readPullRequest(repo, indexArg)) ?? {})
  if (source === null) {
    return {
      ok: false,
      error: 'Could not read the pull request title before changing draft state.'
    }
  }
  return { ok: true, title: applyGiteaDraftTitle(source, updates.draft) }
}

export async function updateGiteaPR(
  repoPath: string,
  index: number,
  updates: GiteaPRUpdate,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  if (!hasMetadataChange(updates)) {
    return { ok: true }
  }
  const resolved = await resolvePull(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedPull(resolved)) {
    return resolved
  }
  const { repo, indexArg } = resolved
  let attempted = false
  try {
    const titleResult = await resolveEditedTitle(repo, indexArg, updates)
    if (!titleResult.ok) {
      return titleResult
    }
    const addLabels = cleanNames(updates.addLabels)
    const removeLabels = cleanNames(updates.removeLabels)
    attempted = true
    if (giteaWriteUsesTea(repo)) {
      const flags: string[] = []
      if (titleResult.title !== undefined) {
        flags.push('--title', titleResult.title)
      }
      if (updates.body !== undefined) {
        flags.push('--description', updates.body)
      }
      if (addLabels.length > 0) {
        flags.push('--add-labels', addLabels.join(','))
      }
      if (removeLabels.length > 0) {
        flags.push('--remove-labels', removeLabels.join(','))
      }
      if (updates.draft === true) {
        flags.push('--draft')
      } else if (updates.draft === false) {
        flags.push('--ready')
      }
      const args = teaPullCommand(repo, ['edit', indexArg, ...flags])
      if (!args) {
        return giteaAuthRequiredResult()
      }
      const edited = await runGiteaTeaCommand(args, localGitOptions, repoPath)
      return edited.ok ? { ok: true } : edited
    }

    const patch: Record<string, unknown> = {}
    if (titleResult.title !== undefined) {
      patch.title = titleResult.title
    }
    if (updates.body !== undefined) {
      patch.body = updates.body
    }
    if (Object.keys(patch).length > 0) {
      const patched = await writeGiteaJson(repo, pullPath(repo, indexArg), 'PATCH', patch)
      if (!patched.ok) {
        return patched
      }
    }
    return applyGiteaPullRequestLabelChanges(repo, indexArg, addLabels, removeLabels)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (attempted) {
      invalidateGiteaPullRequestScanForRepo(repo)
    }
  }
}
