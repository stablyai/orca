import type { ClickUpWorkspace } from '../../../../../src/shared/clickup/clickup-types'
import type { UnvalidatedRpcRequestPort } from '../../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { translate } from '../../../i18n/mobile-i18n'
import { RpcIncompatibleReplyError } from '../../../transport/rpc/rpc-incompatible-reply-error'
import { clickUpConnectionStatusSchema } from './clickup-reply-schema'
import {
  clickUpConnectionStatusProbe,
  clickUpConnectionStatusRead
} from './mobile-clickup-operations'

export type MobileClickUpConnection = {
  connected: boolean
  workspaces: ClickUpWorkspace[]
  selectedWorkspaceId: string | null
  credentialError: string | null
  unavailableReason: string | null
  // A read that worked before now finds ClickUp disconnected: the desktop dropped it or ClickUp rejected the token.
  lostConnection: boolean
  // `unread` until a status read answers; `unreachable` when the first read failed, so the screen cannot claim ClickUp is disconnected.
  readState: 'unread' | 'read' | 'unreachable'
}

export const DISCONNECTED_CLICKUP_CONNECTION: MobileClickUpConnection = {
  connected: false,
  workspaces: [],
  selectedWorkspaceId: null,
  credentialError: null,
  unavailableReason: null,
  lostConnection: false,
  readState: 'read'
}

export const INITIAL_CLICKUP_CONNECTION: MobileClickUpConnection = {
  ...DISCONNECTED_CLICKUP_CONNECTION,
  readState: 'unread'
}

/** A failed status read: the last loaded connection stays, and one that never loaded becomes unreachable. */
export function reconcileClickUpReadFailure(
  current: MobileClickUpConnection
): MobileClickUpConnection {
  return current.readState === 'unread' ? { ...current, readState: 'unreachable' } : current
}

/** The paired host lacks ClickUp, so no clickup.* method is sent to it and the screen asks for an update. */
export function clickUpHostUpdateRequiredConnection(): MobileClickUpConnection {
  return {
    ...DISCONNECTED_CLICKUP_CONNECTION,
    unavailableReason: translate(
      'tasks.clickUpConnection.updateHost',
      'Update Orca on this host to browse ClickUp on mobile.'
    )
  }
}

export function extractClickUpConnection(result: unknown): MobileClickUpConnection {
  const decoded = clickUpConnectionStatusSchema.safeParse(result)
  if (!decoded.success) {
    return clickUpHostUpdateRequiredConnection()
  }
  const status = decoded.data
  const credentialError = status.credentialError?.trim() || null
  if (!status.connected) {
    return { ...DISCONNECTED_CLICKUP_CONNECTION, credentialError }
  }
  const workspaces = status.workspaces ?? []
  return {
    ...DISCONNECTED_CLICKUP_CONNECTION,
    connected: true,
    workspaces,
    selectedWorkspaceId: workspaces.some((workspace) => workspace.id === status.selectedWorkspaceId)
      ? (status.selectedWorkspaceId ?? null)
      : (workspaces[0]?.id ?? null),
    credentialError
  }
}

// A reply this app cannot read means the host predates ClickUp; a failed request says nothing about the host, so it throws and the caller keeps its last connection.
export function readClickUpConnectionProbeReply(reply: RpcResponse): MobileClickUpConnection {
  let result: ReturnType<typeof clickUpConnectionStatusProbe.interpret>
  try {
    result = clickUpConnectionStatusProbe.interpret(reply)
  } catch (error) {
    if (error instanceof RpcIncompatibleReplyError) {
      return clickUpHostUpdateRequiredConnection()
    }
    throw error
  }
  if (!result.accepted) {
    throw new Error('The host could not read the ClickUp connection status')
  }
  return extractClickUpConnection(result.value)
}

export function reconcileClickUpConnection(
  current: MobileClickUpConnection,
  next: MobileClickUpConnection
): MobileClickUpConnection {
  return !next.connected && current.connected && !next.unavailableReason
    ? { ...next, lostConnection: true }
    : next
}

// Explicit refreshes surface failures instead of presenting a setup prompt.
export async function readClickUpConnection(
  client: UnvalidatedRpcRequestPort
): Promise<MobileClickUpConnection> {
  return extractClickUpConnection(
    clickUpConnectionStatusRead.interpret(await clickUpConnectionStatusRead.request(client))
  )
}

export function clickUpWorkspaceLabel(workspace: ClickUpWorkspace): string {
  return workspace.name.trim() || workspace.id
}
