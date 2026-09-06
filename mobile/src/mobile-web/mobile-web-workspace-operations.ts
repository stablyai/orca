import { MobileWebWorkspaceActivationPayloadSchema } from '../../../src/shared/mobile-web/bridge-operation-contract'
import {
  MobileWebWorkspaceRemovePayloadSchema,
  MobileWebWorkspaceRemoveResultSchema,
  MobileWebWorkspaceRepositoriesPayloadSchema,
  MobileWebWorkspaceSettingsSnapshotPayloadSchema,
  MobileWebWorkspaceSettingsUpdatePayloadSchema,
  MobileWebWorkspaceUpdatePayloadSchema,
  MobileWebWorkspaceUpdateResultSchema
} from '../../../src/shared/mobile-web/workspace-presentation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebWorkspaceActivation } from './mobile-web-workspace-activation'
import { executeMobileWebWorkspaceCreationReadOperation } from './mobile-web-workspace-creation-read-operations'
import { executeMobileWebWorkspaceCreationSourceOperation } from './mobile-web-workspace-creation-source-operations'
import { executeMobileWebWorkspaceCreationCreateOperation } from './mobile-web-workspace-creation-create-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import {
  hostWorkspaceSettings,
  mobileWebWorkspaceRepositories,
  mobileWebWorkspaceSettings
} from './mobile-web-workspace-presentation'
import type { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

export async function executeMobileWebWorkspaceOperation(args: {
  capability: 'workspace' | 'settings'
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  snapshots: MobileWebWorkspaceSnapshotPager
}): Promise<unknown> {
  if (args.capability === 'settings') {
    return executeSettingsOperation(args)
  }
  if (args.operation.startsWith('creation')) {
    if (args.operation.startsWith('creationCreate')) {
      return executeMobileWebWorkspaceCreationCreateOperation(args)
    }
    if (
      args.operation.startsWith('creationSearch') ||
      args.operation.startsWith('creationLookup') ||
      args.operation.startsWith('creationResolve')
    ) {
      return executeMobileWebWorkspaceCreationSourceOperation(args)
    }
    return executeMobileWebWorkspaceCreationReadOperation(args)
  }
  if (args.operation === 'snapshot') {
    return args.snapshots.snapshot(args.payload, args.client, args.authority)
  }
  if (args.operation === 'repositories') {
    MobileWebWorkspaceRepositoriesPayloadSchema.parse(args.payload)
    return readRepositories(args.client, args.authority)
  }
  if (args.operation === 'activate') {
    const payload = MobileWebWorkspaceActivationPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.authority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('worktree.activate', {
      worktree: `id:${hostWorkspaceId}`,
      notifyClients: false,
      navigation: 'caller'
    })
    requireSuccess(response)
    return mobileWebWorkspaceActivation(response.result, hostWorkspaceId, payload.workspaceId)
  }
  if (args.operation === 'update') {
    const payload = MobileWebWorkspaceUpdatePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.authority.hostWorkspaceId(payload.workspaceId)
    const response =
      payload.mutation === 'pin'
        ? await args.client.sendRequest('worktree.set', {
            worktree: `id:${hostWorkspaceId}`,
            isPinned: payload.pinned
          })
        : await args.client.sendRequest('worktree.sleep', {
            worktree: `id:${hostWorkspaceId}`
          })
    requireSuccess(response)
    return MobileWebWorkspaceUpdateResultSchema.parse({
      workspaceId: payload.workspaceId,
      updated: true
    })
  }
  if (args.operation === 'remove') {
    const payload = MobileWebWorkspaceRemovePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.authority.hostWorkspaceId(payload.workspaceId)
    requireSuccess(
      await args.client.sendRequest('worktree.rm', {
        worktree: `id:${hostWorkspaceId}`,
        force: true
      })
    )
    return MobileWebWorkspaceRemoveResultSchema.parse({
      workspaceId: payload.workspaceId,
      removed: true
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function executeSettingsOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  if (args.operation === 'snapshot') {
    MobileWebWorkspaceSettingsSnapshotPayloadSchema.parse(args.payload)
    await readRepositories(args.client, args.authority)
    const response = await args.client.sendRequest('ui.get')
    requireSuccess(response)
    return mobileWebWorkspaceSettings(response.result, args.authority)
  }
  if (args.operation === 'update') {
    const payload = MobileWebWorkspaceSettingsUpdatePayloadSchema.parse(args.payload)
    await readRepositories(args.client, args.authority)
    requireSuccess(
      await args.client.sendRequest('ui.set', hostWorkspaceSettings(payload, args.authority))
    )
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function readRepositories(
  client: RpcClient,
  authority: MobileWebWorkspaceAuthority
): Promise<unknown> {
  const response = await client.sendRequest('repo.list')
  requireSuccess(response)
  return mobileWebWorkspaceRepositories(response.result, authority)
}

function requireSuccess(response: {
  ok: boolean
  error?: { code?: unknown }
}): asserts response is {
  ok: true
  result: unknown
} {
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error ?? {})
  }
}
