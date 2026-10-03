import type { z } from 'zod'
import type {
  YouTrackCommentAdd,
  YouTrackFieldSet,
  YouTrackIssueCreate,
  YouTrackIssueList,
  YouTrackIssueRead,
  YouTrackStateSet
} from '../../shared/rpc-contract/youtrack-agent-params'
import type { CurrentWorktreeContextHints } from '../../shared/current-worktree-context'
import type { Worktree } from '../../shared/worktree/types'
import { parseYouTrackIssueReference } from '../../shared/youtrack-issue-reference'
import type { YouTrackComment, YouTrackIssue } from '../../shared/youtrack-types'
import {
  addComment,
  getComments,
  getIssue,
  getStateOptions,
  getStatus,
  listIssues,
  setState
} from './client'
import { createIssue, listProjects, updateField } from './issue-mutations'
import {
  resolveCallerWorktree,
  type CallerWorktreeFailure,
  type CallerWorktreeLookup
} from '../runtime/caller-worktree-resolution'

type IssueTarget = { id?: string; current?: CurrentWorktreeContextHints }

function unwrap<T>(result: ({ ok: true } & T) | { ok: false; error: string }): T {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

const CURRENT_WORKTREE_ERRORS: Record<CallerWorktreeFailure, string> = {
  mismatch: 'The provided worktree context does not match the caller terminal.',
  unverified: 'Could not verify the current YouTrack-linked worktree.',
  outside: 'Run --current from inside an Orca-managed worktree, or pass an issue ID.'
}

export async function resolveYouTrackIssueId(
  target: IssueTarget,
  worktrees: CallerWorktreeLookup<Worktree>
): Promise<string> {
  if (target.id) {
    const id = parseYouTrackIssueReference(target.id, getStatus().baseUrl)
    if (!id) {
      throw new Error(`"${target.id}" is not a YouTrack issue ID or issue URL.`)
    }
    return id
  }
  if (!target.current) {
    throw new Error('Pass an issue ID, or --current from inside a YouTrack-linked worktree.')
  }
  const resolved = await resolveCallerWorktree(target.current, worktrees)
  if (!resolved.ok) {
    throw new Error(CURRENT_WORKTREE_ERRORS[resolved.reason])
  }
  const item = resolved.worktree.linkedWorkItem
  if (item?.provider !== 'youtrack' || !item.youtrackIdentifier) {
    throw new Error('The current worktree is not linked to a YouTrack issue.')
  }
  return item.youtrackIdentifier
}

export async function readYouTrackIssueForAgents(
  params: z.infer<typeof YouTrackIssueRead>,
  worktrees: CallerWorktreeLookup<Worktree>
): Promise<{ issue: YouTrackIssue; comments?: YouTrackComment[] }> {
  const id = await resolveYouTrackIssueId(params, worktrees)
  const { issue } = unwrap(await getIssue(id))
  if (!params.comments) {
    return { issue }
  }
  return { issue, comments: unwrap(await getComments(id)).comments }
}

export async function listYouTrackIssuesForAgents(
  params: z.infer<typeof YouTrackIssueList>
): Promise<{ issues: YouTrackIssue[] }> {
  return { issues: unwrap(await listIssues(params)).issues }
}

export async function addYouTrackCommentForAgents(
  params: z.infer<typeof YouTrackCommentAdd>,
  worktrees: CallerWorktreeLookup<Worktree>
): Promise<{ idReadable: string; comment: YouTrackComment }> {
  const idReadable = await resolveYouTrackIssueId(params, worktrees)
  return { idReadable, comment: unwrap(await addComment(idReadable, params.text)).comment }
}

export async function setYouTrackStateForAgents(
  params: z.infer<typeof YouTrackStateSet>,
  worktrees: CallerWorktreeLookup<Worktree>
): Promise<{ issue: YouTrackIssue }> {
  const idReadable = await resolveYouTrackIssueId(params, worktrees)
  const { options } = unwrap(await getStateOptions(idReadable))
  const wanted = params.state.trim().toLowerCase()
  const option = options.find((candidate) => candidate.label.toLowerCase() === wanted)
  if (!option) {
    const available = options.map((candidate) => candidate.label).join(', ') || 'none'
    throw new Error(
      `"${params.state}" is not available for ${idReadable}. Available: ${available}.`
    )
  }
  return { issue: unwrap(await setState({ idReadable, option })).issue }
}

export async function setYouTrackFieldForAgents(
  params: z.infer<typeof YouTrackFieldSet>,
  worktrees: CallerWorktreeLookup<Worktree>
): Promise<{ issue: YouTrackIssue }> {
  const idReadable = await resolveYouTrackIssueId(params, worktrees)
  const current = unwrap(await getIssue(idReadable)).issue
  if (current.stateFieldName?.toLowerCase() === params.name.trim().toLowerCase()) {
    throw new Error(`Use "orca youtrack state set" to change ${current.stateFieldName}.`)
  }
  const result = await updateField({
    idReadable,
    projectId: current.project.id,
    field: { name: params.name, values: params.values }
  })
  return { issue: unwrap(result).issue }
}

export async function createYouTrackIssueForAgents(
  params: z.infer<typeof YouTrackIssueCreate>
): Promise<{ issue: YouTrackIssue }> {
  const wanted = params.project.trim().toLowerCase()
  const project = unwrap(await listProjects()).projects.find(
    (candidate) =>
      candidate.id === params.project.trim() ||
      candidate.shortName.toLowerCase() === wanted ||
      candidate.name.toLowerCase() === wanted
  )
  if (!project) {
    throw new Error(`No YouTrack project matches "${params.project}".`)
  }
  const result = await createIssue({
    projectId: project.id,
    summary: params.summary,
    description: params.description,
    fields: params.fields ?? []
  })
  return { issue: unwrap(result).issue }
}
