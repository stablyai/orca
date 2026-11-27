import { randomUUID } from 'node:crypto'
import {
  isStreamingMethod,
  type RpcRegistry,
  type RpcResponse,
  type RpcContext,
  type RpcFailure
} from '../../runtime/rpc/core'
import { checkLocalChatTerminalWriters, localChatClient } from './local-chat-routing'
import { isLocalChatMethod } from './local-chat-host-location'

export class LocalChatRpcError extends Error {
  constructor(readonly failure: RpcFailure['error']) {
    super(failure.message)
  }
}

export function routeLocalChatMethods(methods: RpcRegistry): RpcRegistry {
  const client = localChatClient()
  if (!client) {
    return methods
  }
  const registry = new Map(methods)
  for (const [name, method] of methods) {
    if (!isLocalChatMethod(name)) {
      continue
    }
    const forward = async (
      params: unknown,
      context: RpcContext,
      emit?: (result: unknown) => void
    ) => {
      const request = {
        id: context.requestId ?? name,
        method: name,
        params,
        authToken: 'local-chat'
      }
      await checkLocalChatTerminalWriters(context.runtime, request)
      const receive =
        emit &&
        ((frame: RpcResponse) => {
          if (frame.ok) {
            emit(frame.result)
          }
        })
      const controller = new AbortController()
      const registration =
        emit && context.connectionId
          ? context.runtime.registerOwnedSubscriptionCleanup(
              `local-chat-bridge:${randomUUID()}`,
              () => controller.abort(),
              context.connectionId
            )
          : undefined
      const signal = context.signal
        ? AbortSignal.any([controller.signal, context.signal])
        : controller.signal
      const response = await client
        .dispatch(request, { ...context, signal }, receive)
        .finally(() => registration?.releaseIfCurrent())
      if (!emit && !response) {
        throw new Error('Local chat call disconnected')
      }
      if (response && !response.ok) {
        throw new LocalChatRpcError(response.error)
      }
      return response?.result
    }
    registry.set(
      name,
      isStreamingMethod(method)
        ? {
            ...method,
            handler: async (params, context, emit) => {
              await forward(params, context, emit)
            }
          }
        : { ...method, handler: forward }
    )
  }
  return registry
}
