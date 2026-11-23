import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import { reserveAzureDevOpsWrite } from '../azure-devops-write-budget'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import { hydrateAzureDevOpsWorkItems } from './backlog-client'
import { getAzureDevOpsWorkItemTypes } from './work-item-type-metadata'

const WRITE_TIMEOUT_MS = 15_000
// Pinned versions disable the version-negotiation retry, so a write is never sent twice.
const COMMENT_API_VERSION = '6.0-preview.3'
const UPDATE_API_VERSION = '6.0'

/** Azure DevOps renders comments as HTML; an agent's text is escaped so it stays text. */
export function workItemCommentHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
}

export async function addAzureDevOpsWorkItemComment(
  repo: AzureDevOpsRepoRef,
  id: number,
  text: string
): Promise<{ commentId: number }> {
  await currentWorkItem(repo, id)
  await reserveAzureDevOpsWrite('workItemComment')
  const result = await requestAzureDevOpsJsonAtBase<{ id?: number }>(
    resolveAzureDevOpsApiBases(repo).project,
    `/_apis/wit/workItems/${encodeURIComponent(String(id))}/comments`,
    {
      method: 'POST',
      body: { text: workItemCommentHtml(text) },
      searchParams: { 'api-version': COMMENT_API_VERSION },
      timeoutMs: WRITE_TIMEOUT_MS
    },
    true
  )
  return { commentId: result?.id ?? 0 }
}

const TEAM_PROJECT_FIELD = 'System.TeamProject'

/** Ids are unique per organization, so an id from another project must be refused, not patched. */
async function currentWorkItem(repo: AzureDevOpsRepoRef, id: number): Promise<AzureDevOpsWorkItem> {
  const [item] = await hydrateAzureDevOpsWorkItems(repo, [id], [TEAM_PROJECT_FIELD], {
    requireResponse: true
  })
  if (!item) {
    throw new Error(`Work item ${id} was not found in this project.`)
  }
  const project = item.fields[TEAM_PROJECT_FIELD]
  const expected = await canonicalProjectName(repo)
  if (typeof project !== 'string' || project.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Work item ${id} belongs to ${typeof project === 'string' ? `project "${project}"` : 'another project'}, not "${expected}"; pass --repo for that project.`
    )
  }
  return item
}

/** A remote may name the project by GUID; System.TeamProject always carries its name. */
async function canonicalProjectName(repo: AzureDevOpsRepoRef): Promise<string> {
  const project = await requestAzureDevOpsJsonAtBase<{ name?: string | null }>(
    resolveAzureDevOpsApiBases(repo).collection,
    `/_apis/projects/${encodeURIComponent(repo.project)}`,
    { timeoutMs: WRITE_TIMEOUT_MS },
    true
  )
  return project?.name || repo.project
}

/** The approved preview's revision: the write is refused if the item moved past it. */
function requireExpectedRevision(item: AzureDevOpsWorkItem, expectedRev: number | undefined): void {
  if (expectedRev !== undefined && item.rev !== expectedRev) {
    throw new Error(
      `Work item ${item.id} changed after the preview (rev ${expectedRev} → ${item.rev}). Read it again and ask the user before retrying.`
    )
  }
}

async function patchWorkItem(
  repo: AzureDevOpsRepoRef,
  item: AzureDevOpsWorkItem,
  field: string,
  value: string
): Promise<AzureDevOpsWorkItem> {
  await reserveAzureDevOpsWrite('workItemUpdate')
  await requestAzureDevOpsJsonAtBase<unknown>(
    resolveAzureDevOpsApiBases(repo).project,
    `/_apis/wit/workitems/${encodeURIComponent(String(item.id))}`,
    {
      method: 'PATCH',
      contentType: 'application/json-patch+json',
      // `test /rev` refuses the write if someone changed the item since it was read.
      body: [
        { op: 'test', path: '/rev', value: item.rev },
        { op: 'add', path: `/fields/${field}`, value }
      ],
      searchParams: { 'api-version': UPDATE_API_VERSION },
      timeoutMs: WRITE_TIMEOUT_MS
    },
    true
  )
  return currentWorkItem(repo, item.id)
}

/** States differ per process and per type, so the target is checked against the item's own type. */
export async function setAzureDevOpsWorkItemState(
  repo: AzureDevOpsRepoRef,
  id: number,
  state: string,
  expectedRev?: number
): Promise<AzureDevOpsWorkItem> {
  const [item, types] = await Promise.all([
    currentWorkItem(repo, id),
    getAzureDevOpsWorkItemTypes(repo)
  ])
  requireExpectedRevision(item, expectedRev)
  const states = types[item.workItemType]?.states.map((each) => each.name) ?? []
  const match = states.find((name) => name.toLowerCase() === state.trim().toLowerCase())
  if (!match) {
    throw new Error(
      `"${state}" is not a ${item.workItemType} state here. Valid states: ${states.join(', ') || 'unknown'}.`
    )
  }
  if (match === item.state) {
    return item
  }
  return patchWorkItem(repo, item, 'System.State', match)
}

async function signedInAccount(repo: AzureDevOpsRepoRef): Promise<string> {
  const data = await requestAzureDevOpsJsonAtBase<{
    authenticatedUser?: { properties?: { Account?: { $value?: string | null } } | null } | null
  }>(
    resolveAzureDevOpsApiBases(repo).collection,
    '/_apis/connectionData',
    { timeoutMs: 5000 },
    true
  )
  const account = data?.authenticatedUser?.properties?.Account?.$value
  if (!account) {
    throw new Error('Azure DevOps did not say who is signed in; pass the assignee explicitly.')
  }
  return account
}

/** `assignee` is an email or account name, `@me` for the signed-in user, or null to unassign. */
export async function setAzureDevOpsWorkItemAssignee(
  repo: AzureDevOpsRepoRef,
  id: number,
  assignee: string | null,
  expectedRev?: number
): Promise<AzureDevOpsWorkItem> {
  const item = await currentWorkItem(repo, id)
  requireExpectedRevision(item, expectedRev)
  const value =
    assignee === null ? '' : assignee === '@me' ? await signedInAccount(repo) : assignee.trim()
  return patchWorkItem(repo, item, 'System.AssignedTo', value)
}
