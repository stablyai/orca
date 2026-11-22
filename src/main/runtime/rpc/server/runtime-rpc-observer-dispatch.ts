import type { ObserverCredentialStore } from '../../observer-credential-store'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcDispatcher } from '../dispatcher'
import { limitRuntimeRpcReplySize } from './runtime-rpc-reply-size-limit'

export async function dispatchObserverSocketRequest(
  credentials: ObserverCredentialStore,
  dispatcher: RpcDispatcher,
  request: RpcRequest,
  socket: AuthenticatedMobileSocket,
  observerId: string,
  reply: (response: string) => void,
  buildError: (id: string, code: string, message: string) => RpcResponse
): Promise<void> {
  // The handshake alone may be stale: resolve the separate store for every plaintext RPC.
  // Observer sockets never enter relay, paired-device, long-poll, or binary routing.
  const observerToken = socket.device.deviceToken
  const observer =
    socket.transport.transport === 'direct' && observerToken
      ? await credentials.authenticate(observerToken)
      : null
  if (!observer || observer.id !== observerId) {
    reply(
      JSON.stringify(
        buildError(request.id, 'unauthorized', 'Observer credential expired or revoked')
      )
    )
    return
  }
  if (Object.hasOwn(request, 'deviceToken') || Object.hasOwn(request, 'authToken')) {
    reply(
      JSON.stringify(
        buildError(
          request.id,
          'unauthorized',
          'Observer request credentials are not accepted after E2EE authentication'
        )
      )
    )
    return
  }
  const boundedReply = limitRuntimeRpcReplySize(request.id, reply, (id, code, message) =>
    buildError(id, code, message)
  )
  await dispatcher.dispatchStreaming(request, boundedReply, {
    callerScope: {
      kind: 'observer',
      credentialId: observer.id,
      worktreeId: observer.worktreeId,
      worktreeInstanceId: observer.worktreeInstanceId,
      expiresAt: observer.expiresAt
    }
  })
}
