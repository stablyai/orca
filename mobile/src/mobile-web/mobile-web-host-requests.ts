import {
  MobileWebHostRequestPayloadSchema,
  mobileWebHostPayloadByteLength,
  mobileWebHostUnsubscribeMethod
} from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export const MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS = 15_000

/** The page handle a request is scoped to, resolved once and re-checked at every dispatch. Absent
 * when the page sent no workspace, which is how a host-wide method is addressed. */
export type MobileWebHostRequestScope = {
  pageWorkspaceId: string
  hostWorkspaceId: MobileWebHostWorkspaceId
}

export type MobileWebHostRequestArguments = {
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  payload: unknown
  isActive: () => boolean
}

export function assertMobileWebHostRequestScope(
  authority: MobileWebWorkspaceAuthority,
  scope: MobileWebHostRequestScope | undefined
): void {
  if (scope) {
    authority.assertHostWorkspaceBinding(scope.pageWorkspaceId, scope.hostWorkspaceId)
  }
}

/** The desktop socket gate decides which methods a page may reach; the shell only rewrites the
 * page's opaque workspace handle into the host worktree and enforces the bridge envelope. */
export function prepareMobileWebHostRequest(args: MobileWebHostRequestArguments) {
  const payload = MobileWebHostRequestPayloadSchema.parse(args.payload)
  const scope =
    payload.workspaceId === undefined
      ? undefined
      : {
          pageWorkspaceId: payload.workspaceId,
          hostWorkspaceId: args.authority.hostWorkspaceId(payload.workspaceId)
        }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  assertMobileWebHostRequestScope(args.authority, scope)
  const params = {
    ...payload.params,
    ...(scope ? { worktree: `id:${scope.hostWorkspaceId}` } : {})
  }
  if (mobileWebHostPayloadByteLength(params) === undefined) {
    throw new MobileWebBrokerError('too_large')
  }
  // Defined only for a subscribe method, which is what decides the lane each caller may take.
  return {
    payload,
    scope,
    params,
    serverUnsubscribeMethod: mobileWebHostUnsubscribeMethod(payload.method)
  }
}

export async function executeMobileWebHostRequest(
  args: MobileWebHostRequestArguments
): Promise<unknown> {
  const { payload, scope, params, serverUnsubscribeMethod } = prepareMobileWebHostRequest(args)
  const deadline = Date.now() + (payload.timeoutMs ?? MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS)
  const beforeSend = () => {
    if (!args.isActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    if (Date.now() >= deadline) {
      throw new MobileWebBrokerError('timeout')
    }
  }
  // A subscribe method answers with stream frames the stream registry consumes, so the unary
  // promise would hang to its deadline while the desktop subscription stayed open uncancellable.
  if (serverUnsubscribeMethod !== undefined) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  beforeSend()
  const options: SendRequestOptions = {
    timeoutMs: deadline - Date.now(),
    budgetSpansConnect: true,
    beforeSend: () => {
      beforeSend()
      assertMobileWebHostRequestScope(args.authority, scope)
    }
  }
  const response = await args.client.sendRequest(payload.method, params, options)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  assertMobileWebHostRequestScope(args.authority, scope)
  if (mobileWebHostPayloadByteLength(response.result) === undefined) {
    throw new MobileWebBrokerError('too_large')
  }
  return response.result
}
