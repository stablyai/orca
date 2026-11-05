import type { RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { buildDirectRpcWireRequest } from '../../transport/rpc-envelope-fields'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'

import type { ScriptedRpcTransport, FrameListenerCrash } from './scripted-rpc-transport'
import { DEVICE_TOKEN } from './scripted-rpc-device'

export function scriptedSession(owner: ScriptedRpcTransport): RpcClient {
  const streams = new RpcClientStreamRegistry({
    nextId: () => owner.nextFrameId(),
    getState: () => owner.state,
    sendFrame: (frame) => {
      const payload = buildDirectRpcWireRequest(frame, DEVICE_TOKEN)
      const name = owner.occurrence(payload.method)
      let opening = false
      try {
        const descriptor = Object.getOwnPropertyDescriptor(streams, 'streams')
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !(descriptor.value instanceof Map) ||
          Object.getPrototypeOf(descriptor.value) !== Map.prototype
        ) {
          throw new Error('Actual native opening owner is unavailable')
        }
        opening = descriptor.value.has(frame.id)
      } catch (error) {
        owner.fault.report('actual emitted stream owner', error)
      }
      if (opening) {
        const opening = {
          id: payload.id,
          params: payload.params,
          deliver: (response: RpcResponse) => streams.handleResponse(response)
        }
        owner.openStreams.set(name, opening)
      }
      owner.streamPayloads.set(payload.id, name)
      owner.publish(name, payload)
      return true
    }
  })
  owner.registries.push(streams)
  const session: RpcClient = {
    sendRequest: (...args) => {
      const child = owner.causality.currentNative()
      return new Promise<RpcResponse>((resolve, reject) => {
        owner.rejects.set(child.name, reject)
        owner.tracker.sendRequest(...args).then(
          (response) => {
            owner.rejects.delete(child.name)
            resolve(response)
          },
          (error: unknown) => {
            owner.rejects.delete(child.name)
            reject(error)
          }
        )
      })
    },
    subscribe: (method, params, onData, options) =>
      streams.subscribe(
        method,
        params,
        (result) => owner.deliverToListener(onData, result),
        options
      ),
    updateTerminalSubscriptionViewport: (terminal, viewport) =>
      streams.updateTerminalViewport(terminal, viewport),
    getState: () => owner.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: (listener) => {
      owner.listeners.add(listener)
      return () => {
        owner.listeners.delete(listener)
      }
    },
    notifyForeground: () => {},
    close: () => {
      owner.tracker.rejectAll('Connection closed', { deliveryUnknown: true })
    }
  }
  return session
}

export function scriptedRegisteredStreams(
  owner: ScriptedRpcTransport
): { method: string; payload: string | null; cancelled: boolean }[] {
  return owner.registries.flatMap((registry) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shape is checked on the next line, and the registry is the one this transport constructed.
    const streams = (registry as unknown as { streams?: unknown }).streams
    if (!(streams instanceof Map)) {
      throw new Error('RpcClientStreamRegistry no longer holds its open streams in `streams`')
    }
    return [...streams].map(([id, stream]: [string, { method?: unknown; cancelled?: unknown }]) => {
      if (typeof stream.method !== 'string') {
        throw new Error(`Registered stream ${id} has no method`)
      }
      // Cancelled records await an unsubscribe id; only uncancelled records imply missed cleanup.
      return {
        method: stream.method,
        payload: owner.streamPayloads.get(id) ?? null,
        cancelled: stream.cancelled === true
      }
    })
  })
}

export function scriptedDeliverToListener(
  owner: ScriptedRpcTransport,
  onData: (result: unknown) => void,
  result: unknown
): void {
  try {
    onData(result)
  } catch (error) {
    owner.listenerCrash = { error }
    throw error
  }
}

export function scriptedTakeListenerCrash(owner: ScriptedRpcTransport): FrameListenerCrash | null {
  const crash = owner.listenerCrash
  owner.listenerCrash = null
  return crash
}
