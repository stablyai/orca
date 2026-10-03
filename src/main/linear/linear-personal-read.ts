import type { LinearClient } from '@linear/sdk'
import { getOrcaProfileListState } from '../orca-profiles/profile-index-store'
import { getClient, isAuthError } from './client'
import { clearToken } from './linear-token-store'
import {
  getCredentialError,
  getWorkspaceState,
  recordCredentialError
} from './linear-workspace-registry'
import type { LinearPersonalReadScope } from '../../shared/linear/personal-read-types'

export async function readWithVerifiedLinearViewer<T>(
  workspaceId: string,
  read: (client: LinearClient, scope: LinearPersonalReadScope) => Promise<T>
): Promise<{ scope: LinearPersonalReadScope; data: T }> {
  const profileId = getOrcaProfileListState().activeProfileId
  const saved = getWorkspaceState().workspaces.find((workspace) => workspace.id === workspaceId)
  if (!saved) {
    throw new Error('Personal Inbox requires a Linear connection on this device.')
  }
  if (!saved.viewerId || !saved.credentialEpoch || !saved.credentialOwnerProfileId) {
    throw new Error('Reconnect Linear on this device to confirm your Inbox identity.')
  }
  if (saved.credentialOwnerProfileId !== profileId) {
    throw new Error('Reconnect Linear in this Orca profile to read your Inbox.')
  }
  const credentialError = getCredentialError(workspaceId)
  if (credentialError) {
    throw new Error(credentialError)
  }
  const scope: LinearPersonalReadScope = {
    profileId,
    workspaceId,
    viewerId: saved.viewerId,
    credentialRevision: saved.credentialRevision ?? 0,
    credentialEpoch: saved.credentialEpoch
  }
  function isCurrent(): boolean {
    return (
      getOrcaProfileListState().activeProfileId === profileId &&
      getWorkspaceState().workspaces.find((workspace) => workspace.id === workspaceId) === saved
    )
  }
  function assertCurrent(): void {
    if (!isCurrent()) {
      throw new Error('Linear connection or Orca profile changed. Refresh your Inbox.')
    }
  }
  const client = getClient(workspaceId)
  if (!client) {
    throw new Error('Reconnect Linear on this device to read your Inbox.')
  }
  try {
    const viewer = await client.viewer
    const organization = await viewer.organization
    assertCurrent()
    if (viewer.id !== scope.viewerId || organization.id !== workspaceId) {
      const message = 'Linear identity changed. Reconnect Linear before reading personal data.'
      recordCredentialError(workspaceId, message)
      throw new Error(message)
    }
    const data = await read(client, scope)
    assertCurrent()
    return { scope, data }
  } catch (error) {
    // An old request must never revoke a replacement connection.
    if (isCurrent() && isAuthError(error)) {
      clearToken(workspaceId)
    }
    throw error
  }
}
