import type {
  ShortcutMember,
  ShortcutTeam,
  ShortcutWorkflow,
  ShortcutWorkflowState
} from '../../shared/shortcut-types'
import { acquire, release } from './request-queue'
import { shortcutRequest, type ShortcutClientForWorkspace } from './authenticated-request'
import { mapMember, mapTeam, mapWorkflow } from './api-mapping'

// Search/list payloads reference workflow states, members, and teams only by
// id; this cache denormalizes them once per workspace so every story read does
// not pay three extra requests.
const METADATA_TTL_MS = 5 * 60_000

export type ShortcutStateLookup = {
  state: ShortcutWorkflowState
  workflowId: string
  workflowName: string
}

export type ShortcutWorkspaceMetadata = {
  workflows: ShortcutWorkflow[]
  statesById: Map<string, ShortcutStateLookup>
  membersById: Map<string, ShortcutMember>
  // membersById keeps disabled members resolvable on old stories; this list is
  // what owner pickers offer.
  activeMembers: ShortcutMember[]
  teamsById: Map<string, ShortcutTeam>
}

type CachedMetadata = {
  fetchedAt: number
  metadata: ShortcutWorkspaceMetadata
}

const cache = new Map<string, CachedMetadata>()
const inflight = new Map<string, Promise<ShortcutWorkspaceMetadata>>()

async function pooledRequest<T>(client: ShortcutClientForWorkspace, path: string): Promise<T> {
  await acquire()
  try {
    return await shortcutRequest<T>(client, path)
  } finally {
    release()
  }
}

async function fetchMetadata(
  client: ShortcutClientForWorkspace
): Promise<ShortcutWorkspaceMetadata> {
  // Sequential on purpose: parallel fetches would occupy most of the shared
  // request pool during a multi-workspace fan-out.
  const rawWorkflows = await pooledRequest<unknown[]>(client, '/api/v3/workflows')
  const rawMembers = await pooledRequest<unknown[]>(client, '/api/v3/members')
  const rawTeams = await pooledRequest<unknown[]>(client, '/api/v3/groups')

  const workflows = (Array.isArray(rawWorkflows) ? rawWorkflows : [])
    .map(mapWorkflow)
    .filter((workflow): workflow is ShortcutWorkflow => workflow !== null)
  const statesById = new Map<string, ShortcutStateLookup>()
  for (const workflow of workflows) {
    for (const state of workflow.states) {
      statesById.set(state.id, { state, workflowId: workflow.id, workflowName: workflow.name })
    }
  }

  const membersById = new Map<string, ShortcutMember>()
  const activeMembers: ShortcutMember[] = []
  for (const raw of Array.isArray(rawMembers) ? rawMembers : []) {
    const member = mapMember(raw)
    if (!member) {
      continue
    }
    membersById.set(member.id, member)
    const record = raw as Record<string, unknown>
    if (record.disabled !== true) {
      activeMembers.push(member)
    }
  }
  activeMembers.sort((a, b) => a.name.localeCompare(b.name))

  const teamsById = new Map<string, ShortcutTeam>()
  for (const raw of Array.isArray(rawTeams) ? rawTeams : []) {
    const team = mapTeam(raw)
    if (team && (raw as Record<string, unknown>).archived !== true) {
      teamsById.set(team.id, team)
    }
  }

  return { workflows, statesById, membersById, activeMembers, teamsById }
}

export async function getWorkspaceMetadata(
  client: ShortcutClientForWorkspace
): Promise<ShortcutWorkspaceMetadata> {
  const workspaceId = client.workspace.id
  const cached = cache.get(workspaceId)
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) {
    return cached.metadata
  }
  const pending = inflight.get(workspaceId)
  if (pending) {
    return pending
  }
  const promise = fetchMetadata(client)
    .then((metadata) => {
      cache.set(workspaceId, { fetchedAt: Date.now(), metadata })
      return metadata
    })
    .finally(() => {
      inflight.delete(workspaceId)
    })
  inflight.set(workspaceId, promise)
  return promise
}

export function clearWorkspaceMetadata(workspaceId?: string): void {
  if (workspaceId) {
    cache.delete(workspaceId)
    inflight.delete(workspaceId)
    return
  }
  cache.clear()
  inflight.clear()
}
