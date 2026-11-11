// The phone's side of synced cloud workspace prefs (/v1/team/prefs): the same pins and order as
// the member's desktops, read and written with the phone's own device-signed token, and W-number
// links (orca://cloud/<org>/W-123) resolved to a workspace.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import {
  CloudWorkspaceLinkResponseSchema,
  CloudWorkspacePrefsSchema,
  EMPTY_CLOUD_WORKSPACE_PREFS,
  type CloudWorkspaceLinkTarget,
  type CloudWorkspacePrefs,
  type CloudWorkspacePrefsDocument
} from '../../../src/shared/cloud-workspaces/cloud-workspaces-wire'
import {
  CloudRequestError,
  cloudRequest as request,
  type CloudControlPlane
} from './cloud-control-plane-request'
import { loadCloudControlPlane } from './cloud-session'

const MAX_ATTEMPTS = 4

export function getCloudWorkspacePrefs(
  plane: CloudControlPlane,
  signal?: AbortSignal
): Promise<CloudWorkspacePrefs> {
  return request(plane, 'GET', '/v1/team/prefs', CloudWorkspacePrefsSchema, { signal })
}

/**
 * Applies `edit` to the newest server copy and writes it with compare-and-set; when a desktop wrote
 * first it re-reads and applies the same edit again.
 */
export async function editCloudWorkspacePrefsOn(
  plane: CloudControlPlane,
  edit: (doc: CloudWorkspacePrefsDocument) => CloudWorkspacePrefsDocument
): Promise<CloudWorkspacePrefs> {
  let current = await getCloudWorkspacePrefs(plane)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const next = edit(current.document)
    if (next === current.document) {
      return current
    }
    try {
      return await request(plane, 'PUT', '/v1/team/prefs', CloudWorkspacePrefsSchema, {
        body: { document: next, revision: current.revision }
      })
    } catch (error) {
      if (!(error instanceof CloudRequestError) || error.code !== 'conflict') {
        throw error
      }
      current = await getCloudWorkspacePrefs(plane)
    }
  }
  throw new CloudRequestError('conflict', 409, 'stale_revision')
}

/** Either link form → the workspace's sandbox id (null when this account can't see it). */
export async function resolveCloudWorkspaceLink(
  plane: CloudControlPlane,
  target: CloudWorkspaceLinkTarget
): Promise<string | null> {
  if (target.kind === 'id') {
    return target.workspaceId
  }
  const params = new URLSearchParams({ org: target.org, n: String(target.number) })
  try {
    const body = await request(
      plane,
      'GET',
      `/v1/team/links/resolve?${params}`,
      CloudWorkspaceLinkResponseSchema
    )
    return body.workspace.id
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 404) {
      return null
    }
    throw error
  }
}

export const cloudWorkspacePrefsQueryKey = (sessionId: string | null) =>
  ['orca-cloud', 'prefs', sessionId] as const

/** This member's synced prefs and an edit that saves them (shown at once, rolled back on failure). */
export function useCloudWorkspacePrefs(sessionId: string | null) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: cloudWorkspacePrefsQueryKey(sessionId),
    enabled: sessionId !== null,
    queryFn: async ({ signal }) => {
      const plane = await loadCloudControlPlane()
      return plane
        ? (await getCloudWorkspacePrefs(plane, signal)).document
        : EMPTY_CLOUD_WORKSPACE_PREFS
    },
    // Desktops edit it too; pick their edits up whenever Home is in front.
    refetchInterval: 15_000,
    staleTime: 5_000
  })
  const edit = useCallback(
    async (change: (doc: CloudWorkspacePrefsDocument) => CloudWorkspacePrefsDocument) => {
      const key = cloudWorkspacePrefsQueryKey(sessionId)
      const previous = client.getQueryData<CloudWorkspacePrefsDocument>(key)
      client.setQueryData<CloudWorkspacePrefsDocument>(key, (doc) =>
        change(doc ?? EMPTY_CLOUD_WORKSPACE_PREFS)
      )
      try {
        const plane = await loadCloudControlPlane()
        if (!plane) {
          throw new CloudRequestError('not_enrolled', 0)
        }
        const saved = await editCloudWorkspacePrefsOn(plane, change)
        client.setQueryData(key, saved.document)
        return true
      } catch {
        client.setQueryData(key, previous)
        return false
      }
    },
    [client, sessionId]
  )
  return { document: query.data ?? EMPTY_CLOUD_WORKSPACE_PREFS, edit }
}
