import type { LinearClient, ProjectUpdateHealthType } from '@linear/sdk'
import type {
  LinearProjectUpdateHealth,
  LinearProjectUserRef
} from '../../shared/linear/project-agent-access'
import { getClients } from './client'
import { normalizeLinearLineEndings } from './linear-text-digest'
import { PROJECT_MEMBER_FIELDS } from './project-connection-pages'
import { mapLinearProjectUserRef, toLinearProjectUpdateHealth } from './project-reference-mapping'
import type { ProjectShowUserNode } from './project-show-query'
import {
  LinearWriteFailure,
  confirmLinearWrite,
  linearWriteClient,
  runLinearLookup,
  runLinearWrite
} from './write-execution'

export type LinearProjectUpdateRecord = {
  id: string
  projectId: string
  body: string
  health: LinearProjectUpdateHealth
  url: string
  isDiffHidden: boolean
  isStale: boolean
  createdAt: string
  updatedAt: string
  editedAt: string | null
  user: LinearProjectUserRef
}

type ProjectUpdateNode = {
  id: string
  body?: string | null
  health?: string | null
  url?: string | null
  isDiffHidden?: boolean | null
  isStale?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  editedAt?: string | null
  project?: { id: string } | null
  user?: ProjectShowUserNode | null
}

type ProjectUpdateByIdResponse = { projectUpdate?: ProjectUpdateNode | null }

const PROJECT_UPDATE_BY_ID_QUERY = `
  query OrcaLinearProjectUpdateById($id: String!) {
    projectUpdate(id: $id) {
      id
      body
      health
      url
      isDiffHidden
      isStale
      createdAt
      updatedAt
      editedAt
      project { id }
      user { ${PROJECT_MEMBER_FIELDS} }
    }
  }
`

const UNCONFIRMED_MESSAGE = 'Project update was posted but could not be retrieved'

function mapProjectUpdateRecord(node: ProjectUpdateNode): LinearProjectUpdateRecord | null {
  const projectId = node.project?.id
  if (!projectId || !node.user) {
    return null
  }
  return {
    id: node.id,
    projectId,
    // Why: the read-back body is compared against the LF-normalized intent.
    body: normalizeLinearLineEndings(node.body ?? ''),
    health: toLinearProjectUpdateHealth(node.health) ?? 'onTrack',
    url: node.url ?? '',
    isDiffHidden: node.isDiffHidden ?? false,
    isStale: node.isStale ?? false,
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    editedAt: node.editedAt ?? null,
    user: mapLinearProjectUserRef(node.user)
  }
}

async function readProjectUpdateRecord(
  client: LinearClient,
  id: string
): Promise<LinearProjectUpdateRecord | null> {
  const result = await client.client.rawRequest<ProjectUpdateByIdResponse, Record<string, unknown>>(
    PROJECT_UPDATE_BY_ID_QUERY,
    { id }
  )
  const node = result.data?.projectUpdate
  return node ? mapProjectUpdateRecord(node) : null
}

/** `projectUpdateCreate` — appends an activity post. Write-id capable. */
export async function addProjectUpdateForAgent(
  projectId: string,
  input: { body: string; health?: LinearProjectUpdateHealth; isDiffHidden: boolean; id: string },
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectUpdateRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createProjectUpdate({
      id: input.id,
      projectId,
      body: normalizeLinearLineEndings(input.body),
      // Why: sent even when false so a pinned write-id probe can compare intent.
      isDiffHidden: input.isDiffHidden,
      ...(input.health ? { health: input.health as ProjectUpdateHealthType } : {})
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Failed to post project update')
    }
    const created = await confirmLinearWrite(UNCONFIRMED_MESSAGE, async () => result.projectUpdate)
    if (!created?.id) {
      throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE)
    }
    const record = await confirmLinearWrite(UNCONFIRMED_MESSAGE, () =>
      readProjectUpdateRecord(client, created.id)
    )
    if (!record) {
      throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE)
    }
    return record
  })
}

/** Read-back for `--write-id` probing and duplicate-id recovery; null only on a true miss. */
export async function getProjectUpdateById(
  projectUpdateId: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectUpdateRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  const client = linearWriteClient(entry, options.signal)
  return runLinearLookup(entry, () => readProjectUpdateRecord(client, projectUpdateId))
}
