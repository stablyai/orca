import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import { requestGiteaJson } from './gitea-json-request'
import { applyGiteaPullRequestLabelChanges } from './pull-request-label-edit'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  giteaWriteUsesGt,
  resolveGiteaMutationRepo,
  runGiteaGtCommand,
  writeGiteaJson,
  type GiteaMutationFailure,
  type GiteaMutationResult,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import { gtRepoArgs, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'
import type { GiteaIssueUpdate } from '../../shared/gitea-types'

export type { GiteaIssueUpdate }

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
    flags.push('--body', updates.body)
  }
  const addLabels = cleanNames(updates.addLabels)
  const removeLabels = cleanNames(updates.removeLabels)
  const addAssignees = cleanNames(updates.addAssignees)
  const removeAssignees = cleanNames(updates.removeAssignees)
  for (const label of addLabels) {
    flags.push('--add-label', label)
  }
  for (const label of removeLabels) {
    flags.push('--remove-label', label)
  }
  for (const assignee of addAssignees) {
    flags.push('--add-assignee', assignee)
  }
  for (const assignee of removeAssignees) {
    flags.push('--remove-assignee', assignee)
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

async function resolveUpdatedAssignees(
  repo: GiteaRepoRef,
  indexArg: string,
  updates: GiteaIssueUpdate
): Promise<{ ok: true; names: string[] } | GiteaMutationFailure> {
  const add = cleanNames(updates.addAssignees)
  const remove = new Set(cleanNames(updates.removeAssignees))
  const path = `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}`
  const existing = await requestGiteaJson<unknown>(repo, path)
  const current = assigneeNames(existing)
  if (current === null) {
    return { ok: false, error: 'Could not load current issue assignees from Gitea.' }
  }
  const next = new Set<string>()
  for (const name of current) {
    if (!remove.has(name)) {
      next.add(name)
    }
  }
  for (const name of add) {
    next.add(name)
  }
  return { ok: true, names: [...next] }
}

async function updateGiteaIssueViaHttp(
  repo: GiteaRepoRef,
  indexArg: string,
  updates: GiteaIssueUpdate
): Promise<GiteaMutationResult> {
  const path = `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}`
  const body: Record<string, unknown> = {}
  if (updates.state) {
    body.state = updates.state === 'closed' ? 'closed' : 'open'
  }
  const title = updates.title?.trim()
  if (title) {
    body.title = title
  }
  if (updates.body !== undefined) {
    body.body = updates.body
  }
  const needsAssigneeUpdate =
    (updates.addAssignees && updates.addAssignees.length > 0) ||
    (updates.removeAssignees && updates.removeAssignees.length > 0)
  if (needsAssigneeUpdate) {
    const resolved = await resolveUpdatedAssignees(repo, indexArg, updates)
    if (!resolved.ok) {
      return resolved
    }
    body.assignees = resolved.names
  }
  if (Object.keys(body).length > 0) {
    const wrote = await writeGiteaJson(repo, path, 'PATCH', body)
    if (!wrote.ok) {
      return wrote
    }
  }
  const needsLabelUpdate =
    (updates.addLabels && updates.addLabels.length > 0) ||
    (updates.removeLabels && updates.removeLabels.length > 0)
  if (needsLabelUpdate) {
    return applyGiteaPullRequestLabelChanges(
      repo,
      indexArg,
      cleanNames(updates.addLabels),
      cleanNames(updates.removeLabels),
      'issues'
    )
  }
  return { ok: true }
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
  const indexArg = giteaPullIndexArg(issueNumber)
  if (!indexArg) {
    return { ok: false, error: 'Issue number must be a positive integer.' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId ?? null,
    projectRefOverride ?? null,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: UNRESOLVED_REPO }
  }
  if (!canWrite(repo)) {
    return giteaAuthRequiredResult()
  }

  if (giteaWriteUsesGt(repo)) {
    const verb = stateVerb(updates.state)
    if (verb) {
      const stateResult = await runGiteaGtCommand(
        ['issue', verb, indexArg, ...gtRepoArgs(repo)],
        localGitOptions,
        repoPath
      )
      if (!stateResult.ok) {
        return stateResult
      }
    }
    const flags = editFlags(updates)
    if (flags.length > 0) {
      const editResult = await runGiteaGtCommand(
        ['issue', 'edit', indexArg, ...gtRepoArgs(repo), ...flags],
        localGitOptions,
        repoPath
      )
      if (!editResult.ok) {
        return editResult
      }
    }
    return { ok: true }
  }

  return updateGiteaIssueViaHttp(repo, indexArg, updates)
}
