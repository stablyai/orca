import type { LinearAttentionRequest, LinearTriagePage } from '../../shared/linear/attention-types'
import { getClients, isAuthError } from './client'
import { clearToken } from './linear-token-store'
import { getWorkspaceState } from './linear-workspace-registry'
import { acquire, release } from './linear-request-concurrency'
import { getListIssueConnectionLoader, mapRawIssueForWorkspace } from './linear-issue-query-support'
import { readAttentionCursor, saveAttentionCursor } from './linear-attention-cursors'

export async function readLinearTriage(
  args: LinearAttentionRequest & { teamId: string }
): Promise<LinearTriagePage> {
  const entry = getClients(args.workspaceId).find((item) => item.workspace.id === args.workspaceId)
  if (!entry) {
    throw new Error('Connect this Linear workspace on this device to read Triage.')
  }
  await acquire()
  try {
    const team = await entry.client.team(args.teamId)
    const organization = await team.organization
    if (organization.id !== args.workspaceId) {
      throw new Error('The team belongs to another workspace.')
    }
    if (!team.triageEnabled) {
      return {
        items: [],
        nextCursor: null,
        unavailable: 'Triage is not enabled for this team in Linear.'
      }
    }
    const state = await team.triageIssueState
    if (!state || state.type !== 'triage') {
      throw new Error('Linear did not provide a Triage workflow state for this team.')
    }
    const namespace = JSON.stringify(['triage', entry.workspace, args.teamId, state.id])
    const after = readAttentionCursor(args.cursor, namespace)
    const connection = await getListIssueConnectionLoader(entry, 'all', {
      rejectPartialResponse: true,
      teamId: args.teamId,
      attributeFilter: { stateIds: [state.id], priorities: [], labelIds: [], assignee: null }
    })({ first: 50, after })
    if (!connection?.nodes || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('Linear returned an incomplete Triage response.')
    }
    if (
      getWorkspaceState().workspaces.find((workspace) => workspace.id === args.workspaceId) !==
      entry.workspace
    ) {
      throw new Error('Linear connection changed. Refresh Triage.')
    }
    return {
      items: connection.nodes.map((node) => mapRawIssueForWorkspace(entry, node)),
      nextCursor: saveAttentionCursor(
        namespace,
        { ...connection.pageInfo, hasNextPage: connection.pageInfo.hasNextPage },
        after
      )
    }
  } catch (error) {
    if (
      isAuthError(error) &&
      getWorkspaceState().workspaces.find((workspace) => workspace.id === args.workspaceId) ===
        entry.workspace
    ) {
      clearToken(args.workspaceId)
    }
    throw error
  } finally {
    release()
  }
}
