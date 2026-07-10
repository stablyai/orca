import type {
  LinearCurrentIssueContextHints,
  LinearIssueChildNode,
  LinearIssueContextResult,
  LinearIssueRequest
} from '../../shared/linear-agent-access'
import { extractLinearInlineMedia } from '../../shared/linear-inline-media'
import { parseLinearIssueInput } from '../../shared/linear-links'
import {
  resolveIssue,
  searchLinearIssuesForAgents,
  type ResolvedIssue
} from './issue-context-client'
import {
  getLinearCurrentIssueFromWorktree,
  resolveLegacyLinearLinkWorkspace,
  type CurrentIssueLink
} from './issue-context-current'
import { LinearAgentAccessError, linearError } from './issue-context-errors'
import { readOptionalIncludes } from './issue-context-includes'

export {
  LinearAgentAccessError,
  getLinearCurrentIssueFromWorktree,
  resolveLegacyLinearLinkWorkspace,
  searchLinearIssuesForAgents
}

export async function readLinearIssueContext(
  request: LinearIssueRequest,
  resolveCurrent: (context?: LinearCurrentIssueContextHints) => Promise<CurrentIssueLink>
): Promise<LinearIssueContextResult> {
  if (request.workspaceId === 'all') {
    throw linearError('linear_invalid_workspace', '--workspace all is not valid for issue reads.', {
      nextSteps: ['Pass a concrete Linear workspace id or omit --workspace.']
    })
  }

  const parsed = request.input ? parseLinearIssueInput(request.input) : null
  if (request.input && !parsed) {
    throw linearError('linear_issue_required', 'Pass a Linear issue identifier or issue URL.', {
      nextSteps: ['Use a Linear identifier like ENG-123 or a https://linear.app/... issue URL.']
    })
  }

  const currentLink = parsed
    ? null
    : request.current
      ? await resolveCurrent(request.context)
      : await missingIssueInput()
  const identifier = parsed?.identifier ?? currentLink?.identifier
  if (!identifier) {
    throw linearError('linear_issue_required', 'Pass an issue id or use --current.')
  }

  const resolved = await resolveIssue(identifier, {
    workspaceId: request.workspaceId ?? currentLink?.workspaceId ?? undefined,
    organizationUrlKey: parsed?.organizationUrlKey ?? currentLink?.organizationUrlKey
  })
  return buildIssueContextResult(resolved, request, currentLink)
}

async function missingIssueInput(): Promise<CurrentIssueLink> {
  throw linearError('linear_issue_required', 'Pass an issue id or use --current.', {
    nextSteps: ['Run `orca linear issue ENG-123` or retry from a linked worktree with --current.']
  })
}

async function buildIssueContextResult(
  resolved: ResolvedIssue,
  request: LinearIssueRequest,
  currentLink: CurrentIssueLink | null
): Promise<LinearIssueContextResult> {
  const includeErrors: LinearIssueContextResult['meta']['includeErrors'] = []
  const sections: LinearIssueContextResult['meta']['sections'] = {}
  const result: LinearIssueContextResult = {
    issue: resolved.issue,
    meta: {
      requested: {
        id: request.input,
        current: request.current === true,
        workspaceId: request.workspaceId,
        include: request.include,
        depth: request.depth
      },
      resolved: {
        id: resolved.issue.id,
        identifier: resolved.issue.identifier,
        workspaceId: resolved.workspace.id,
        workspaceName: resolved.workspace.organizationName,
        ...(currentLink?.worktreeId ? { worktreeId: currentLink.worktreeId } : {}),
        ...(currentLink?.worktreePath ? { worktreePath: currentLink.worktreePath } : {})
      },
      partial: false,
      includeErrors,
      sections
    }
  }

  await readOptionalIncludes(resolved, request, result, includeErrors, sections)
  result.inlineMedia = collectInlineMedia(result)
  result.meta.partial = includeErrors.length > 0
  return result
}

export function collectInlineMedia(
  result: LinearIssueContextResult
): LinearIssueContextResult['inlineMedia'] {
  const media = [
    ...extractLinearInlineMedia(result.issue.description, 'description'),
    ...(result.comments ?? []).flatMap(
      // Prefer media pre-extracted from the full (untruncated) comment body;
      // fall back to the stored body for callers that did not pre-extract.
      (comment) =>
        comment.inlineMedia ?? extractLinearInlineMedia(comment.body, 'comment', comment.id)
    ),
    ...(result.children ?? []).flatMap((child) => collectChildInlineMedia(child))
  ]
  return media.length > 0 ? media : undefined
}

function collectChildInlineMedia(
  child: LinearIssueChildNode
): NonNullable<LinearIssueContextResult['inlineMedia']> {
  return [
    ...extractLinearInlineMedia(child.description, 'child-description', child.id),
    ...(child.children ?? []).flatMap((nested) => collectChildInlineMedia(nested))
  ]
}
