import type { ClickUpList, ClickUpTag, ClickUpUser, ClickUpWorkspaceSelection } from '../../shared/clickup-types'
import {
  clickUpRequest,
  requireClickUpClient,
  requireClickUpClients,
  type ClickUpClientForWorkspace
} from './client'
import {
  asRecord,
  asString,
  normalizeClickUpLocation,
  normalizeClickUpStatus,
  normalizeClickUpTag,
  normalizeClickUpUser
} from './task-mapping'

function normalizeList(
  value: unknown,
  client: ClickUpClientForWorkspace,
  fallbackSpace?: { id: string; name: string },
  fallbackFolder?: { id: string; name: string }
): ClickUpList | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  if (!record || !id || !name) {
    return null
  }
  return {
    id,
    workspaceId: client.workspace.id,
    workspaceName: client.workspace.name,
    name,
    url: asString(record.url),
    space: normalizeClickUpLocation(record.space) ?? fallbackSpace,
    folder: normalizeClickUpLocation(record.folder) ?? fallbackFolder,
    statuses: Array.isArray(record.statuses) ? record.statuses.map(normalizeClickUpStatus) : []
  }
}

async function listsForWorkspace(client: ClickUpClientForWorkspace): Promise<ClickUpList[]> {
  const spacesResponse = await clickUpRequest<{ spaces?: unknown[] }>(
    client,
    `/team/${encodeURIComponent(client.workspace.id)}/space?archived=false`
  )
  const spaces = (spacesResponse.spaces ?? []).flatMap((value) => {
    const space = normalizeClickUpLocation(value)
    return space ? [space] : []
  })
  const lists = await Promise.all(
    spaces.map(async (space) => {
      const [folderResponse, folderlessResponse] = await Promise.all([
        clickUpRequest<{ folders?: unknown[] }>(
          client,
          `/space/${encodeURIComponent(space.id)}/folder?archived=false`
        ),
        clickUpRequest<{ lists?: unknown[] }>(
          client,
          `/space/${encodeURIComponent(space.id)}/list?archived=false`
        )
      ])
      const folderLists = await Promise.all(
        (folderResponse.folders ?? []).map(async (folderValue) => {
          const folder = normalizeClickUpLocation(folderValue)
          if (!folder) {
            return []
          }
          const response = await clickUpRequest<{ lists?: unknown[] }>(
            client,
            `/folder/${encodeURIComponent(folder.id)}/list?archived=false`
          )
          return (response.lists ?? [])
            .map((list) => normalizeList(list, client, space, folder))
            .filter((list): list is ClickUpList => list !== null)
        })
      )
      return [
        ...(folderlessResponse.lists ?? [])
          .map((list) => normalizeList(list, client, space))
          .filter((list): list is ClickUpList => list !== null),
        ...folderLists.flat()
      ]
    })
  )
  return lists.flat()
}

export async function listClickUpLists(
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpList[]> {
  const lists = await Promise.all(requireClickUpClients(workspaceId).map(listsForWorkspace))
  return lists
    .flat()
    .sort((a, b) =>
      `${a.workspaceName ?? ''}\u0000${a.space?.name ?? ''}\u0000${a.folder?.name ?? ''}\u0000${a.name}`.localeCompare(
        `${b.workspaceName ?? ''}\u0000${b.space?.name ?? ''}\u0000${b.folder?.name ?? ''}\u0000${b.name}`
      )
    )
}

export async function listClickUpWorkspaceMembers(workspaceId?: string): Promise<ClickUpUser[]> {
  const client = requireClickUpClient(workspaceId)
  const response = await clickUpRequest<{ teams?: unknown[] }>(client, '/team')
  const workspace = (response.teams ?? [])
    .map(asRecord)
    .find((team) => asString(team?.id) === client.workspace.id)
  return (Array.isArray(workspace?.members) ? workspace.members : [])
    .map((member) => normalizeClickUpUser(asRecord(member)?.user ?? member))
    .filter((user): user is ClickUpUser => user !== null)
}

export async function listClickUpWorkspaceTags(workspaceId?: string): Promise<ClickUpTag[]> {
  const client = requireClickUpClient(workspaceId)
  const response = await clickUpRequest<{ tags?: unknown[] }>(
    client,
    `/team/${encodeURIComponent(client.workspace.id)}/tag`
  )
  return (response.tags ?? [])
    .map(normalizeClickUpTag)
    .filter((tag): tag is ClickUpTag => tag !== null)
}
