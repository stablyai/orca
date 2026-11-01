import type { IssueSourcePreference } from '../../shared/repo-types'
import { requestGiteaJson } from './gitea-json-request'
import { applyGiteaPullRequestLabelChanges } from './pull-request-label-edit'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaMutationErrorText,
  giteaPullIndexArg,
  giteaWriteUsesTea,
  resolveGiteaMutationRepo,
  runGiteaTeaCommand,
  writeGiteaJson,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import { teaRepoArgs, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'

export type GiteaIssueUpdate = {
  state?: 'open' | 'closed'
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

const UNRESOLVED_REPO = 'No Gitea repository found for this repository.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canWrite(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() !== null || Boolean(repo.loginName)
}

function cleanNames(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)
}

function stateVerb(state: GiteaIssueUpdate['state']): 'close' | 'reopen' | null {
  if (state === 'closed') {
    return 'close'
  }
  if (state === 'open') {
    return 'reopen'
  }
  return null
}

function editFlags(updates: GiteaIssueUpdate): string[] {
  const flags: string[] = []
  const title = updates.title?.trim()
  if (title) {
    flags.push('--title', title)
  }
  if (updates.body !== undefined) {
    flags.push('--description', updates.body)
  }
  const addLabels = cleanNames(updates.addLabels)
  const removeLabels = cleanNames(updates.removeLabels)
  const addAssignees = cleanNames(updates.addAssignees)
  const removeAssignees = cleanNames(updates.removeAssignees)
  if (addLabels.length > 0) {
    flags.push('--add-labels', addLabels.join(','))
  }
  if (removeLabels.length > 0) {
    flags.push('--remove-labels', removeLabels.join(','))
  }
  if (addAssignees.length > 0) {
    flags.push('--add-assignees', addAssignees.join(','))
  }
  if (removeAssignees.length > 0) {
    flags.push('--remove-assignees', removeAssignees.join(','))
  }
  return flags
}

function accountName(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null
  }
  const login = typeof entry.login === 'string' ? entry.login.trim() : ''
  const username = typeof entry.username === 'string' ? entry.username.trim() : ''
  return login || username || null
}

function assigneeNames(data: unknown): string[] | null {
  if (!isRecord(data)) {
    return null
  }
  if (!Array.isArray(data.assignees)) {
    return []
  }
  return data.assignees.flatMap((entry) => {
    const name = accountName(entry)
    return name ? [name] : []
  })
}

function applyAssigneeEdits(current: string[], add: string[], remove: string[]): string[] {
  const removeKeys = new Set(remove.map((name) => name.toLowerCase()))
  const kept = current.filter((name) => !removeKeys.has(name.toLowerCase()))
  const seen = new Set(kept.map((name) => name.toLowerCase()))
  const next = [...kept]
  for (const name of add) {
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    next.push(name)
  }
  return next
}

function issuePath(repo: GiteaRepoRef, indexArg: string): string {
  return `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}`
}

async function readAssignees(
  repo: GiteaRepoRef,
  indexArg: string
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  try {
    const names = assigneeNames(
      await requestGiteaJson<unknown>(repo, issuePath(repo, indexArg), {}, true)
    )
    if (!names) {
      return { ok: false, error: 'Could not read the issue assignees.' }
    }
    return { ok: true, names }
  } catch (error) {
    return { ok: false, error: giteaMutationErrorText(error) }
  }
}

async function runIssueTea(
  args: string[],
  repoPath: string,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaMutationResult> {
  const result = await runGiteaTeaCommand(args, localGitOptions, repoPath)
  return result.ok ? { ok: true } : result
}

export async function updateGiteaIssue(
  repoPath: string,
  issueNumber: number,
  updates: GiteaIssueUpdate,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMutationResult> {
  if (updates.title !== undefined && updates.title.trim().length === 0) {
    return { ok: false, error: 'Title is required' }
  }
  const flags = editFlags(updates)
  const verb = stateVerb(updates.state)
  if (!verb && flags.length === 0) {
    return { ok: true }
  }
  const indexArg = giteaPullIndexArg(issueNumber)
  if (!indexArg) {
    return { ok: false, error: 'Issue index must be a positive integer.' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId ?? null,
    projectRefOverride,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: UNRESOLVED_REPO }
  }
  if (!canWrite(repo)) {
    return giteaAuthRequiredResult()
  }

  const addLabels = cleanNames(updates.addLabels)
  const removeLabels = cleanNames(updates.removeLabels)
  if (giteaWriteUsesTea(repo)) {
    if (verb) {
      const changed = await runIssueTea(
        ['issues', verb, indexArg, ...teaRepoArgs(repo)],
        repoPath,
        localGitOptions
      )
      if (!changed.ok) {
        return changed
      }
    }
    if (flags.length === 0) {
      return { ok: true }
    }
    return runIssueTea(
      ['issues', 'edit', indexArg, ...flags, ...teaRepoArgs(repo)],
      repoPath,
      localGitOptions
    )
  }

  const patch: Record<string, unknown> = {}
  if (verb === 'close') {
    patch.state = 'closed'
  } else if (verb === 'reopen') {
    patch.state = 'open'
  }
  if (updates.title !== undefined) {
    patch.title = updates.title.trim()
  }
  if (updates.body !== undefined) {
    patch.body = updates.body
  }
  const addAssignees = cleanNames(updates.addAssignees)
  const removeAssignees = cleanNames(updates.removeAssignees)
  if (addAssignees.length > 0 || removeAssignees.length > 0) {
    const current = await readAssignees(repo, indexArg)
    if (!current.ok) {
      return current
    }
    patch.assignees = applyAssigneeEdits(current.names, addAssignees, removeAssignees)
  }
  if (Object.keys(patch).length > 0) {
    const patched = await writeGiteaJson(repo, issuePath(repo, indexArg), 'PATCH', patch)
    if (!patched.ok) {
      return patched
    }
  }
  return applyGiteaPullRequestLabelChanges(repo, indexArg, addLabels, removeLabels)
}
