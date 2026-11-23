import type { ClickUpWorkspace } from '../../../../../src/shared/clickup/clickup-types'
import type { UnvalidatedRpcRequestPort } from '../../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { translate } from '../../../i18n/mobile-i18n'
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
}

export const DISCONNECTED_CLICKUP_CONNECTION: MobileClickUpConnection = {
  connected: false,
  workspaces: [],
  selectedWorkspaceId: null,
  credentialError: null,
  unavailableReason: null,
  lostConnection: false
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

// Older hosts can refuse ClickUp without taking the other task providers down.
export function readClickUpConnectionProbeReply(
  reply: RpcResponse | null
): MobileClickUpConnection {
  try {
    if (reply) {
      const result = clickUpConnectionStatusProbe.interpret(reply)
      if (result.accepted) {
        return extractClickUpConnection(result.value)
      }
    }
  } catch {
    // An incompatible advisory reply leaves the remaining providers usable.
  }
  return extractClickUpConnection(null)
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
