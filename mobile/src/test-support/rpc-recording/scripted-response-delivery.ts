import { RecordingParamsMismatch, RecordingStreamGuard } from './recording-mismatch'
import type { RpcResponse } from '../../transport/types'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import { captureValue } from './recording-values'
import type { Rejection } from './recording-scenario'

import type { ScriptedRpcTransport, FrameListenerCrash } from './scripted-rpc-transport'

export function scriptedFrame(
  owner: ScriptedRpcTransport,
  name: string,
  params: unknown,
  reply: unknown
): FrameListenerCrash | null {
  const stream = owner.openStreams.get(name)
  if (!stream) {
    const error = new RecordingStreamGuard(
      'scripted-frame-opening',
      name,
      `Missing subscription payload: ${name}`
    )
    owner.stoppedGuard = {
      error,
      evidence: captureValue({
        origin: error.origin,
        requested: name,
        opening: null,
        expected: params,
        replyIssued: false,
        openings: [...owner.openStreams].map(([request, opened]) => ({
          request,
          id: opened.id,
          params: opened.params
        }))
      })
    }
    throw error
  }
  if (JSON.stringify(captureValue(stream.params)) !== JSON.stringify(captureValue(params))) {
    const error = new RecordingStreamGuard(
      'scripted-frame-params',
      name,
      `Subscribe params mismatch: ${name}`
    )
    owner.stoppedGuard = {
      error,
      evidence: captureValue({
        origin: error.origin,
        requested: name,
        opening: { id: stream.id, params: stream.params },
        expected: params,
        replyIssued: false
      })
    }
    throw error
  }
  owner.takeListenerCrash()
  let routed = false
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the response as JSON; the wire id is the transport’s.
    routed = stream.deliver({ ...(reply as object), id: stream.id } as RpcResponse)
  } catch (error) {
    // Record only the listener’s own throw; registry errors mean the scenario stopped matching.
    const crashed = owner.takeListenerCrash()
    if (!crashed || crashed.error !== error) {
      throw error
    }
    return crashed
  }
  const crash = owner.takeListenerCrash()
  if (crash) {
    return crash
  }
  if (!routed) {
    // Streaming frames always route to the opening id; reaching here with a non-streaming reply means the scenario mismatched.
    const error = new RecordingStreamGuard(
      'scripted-frame-routing',
      name,
      `No open stream for frame: ${name}`
    )
    owner.stoppedGuard = {
      error,
      evidence: captureValue({
        origin: error.origin,
        requested: name,
        opening: { id: stream.id, params: stream.params },
        expected: params,
        replyIssued: true,
        routed: false
      })
    }
    throw error
  }
  return null
}

export function scriptedOutstanding(
  owner: ScriptedRpcTransport,
  name: string
): { params: unknown } | undefined {
  const binding = owner.bindings.get(owner.aliases.get(name) ?? name)
  return binding && !binding.completed ? binding : undefined
}

export function scriptedBind(
  owner: ScriptedRpcTransport,
  alias: string,
  name: string,
  params: unknown
): void {
  name = owner.aliases.get(name) ?? name
  const binding = owner.bindings.get(name)
  if (!binding || owner.aliases.has(alias)) {
    throw new Error(`Invalid request binding: ${alias}`)
  }
  if (JSON.stringify(captureValue(binding.params)) !== JSON.stringify(captureValue(params))) {
    throw new Error(`Binding params mismatch: ${alias}`)
  }
  owner.aliases.set(alias, name)
}

export function scriptedComplete(
  owner: ScriptedRpcTransport,
  name: string,
  params: unknown,
  reply: unknown,
  rejection?: Rejection
): void {
  const requested = name
  const alias = owner.aliases.get(name)
  const requestedName = alias ?? name
  const method = owner.bindings.get(requestedName)?.method
  if (
    !alias &&
    [...owner.bindings].filter(([, value]) => value.method === method && !value.completed).length >
      1
  ) {
    throw new Error(`Concurrent requests require a logical binding: ${name}`)
  }
  name = requestedName
  const binding = owner.bindings.get(name)
  if (!binding || binding.completed) {
    throw new Error(`Missing or completed request: ${name}`)
  }
  if (JSON.stringify(captureValue(binding.params)) !== JSON.stringify(captureValue(params))) {
    const error = new RecordingParamsMismatch(
      name,
      binding.method,
      binding.id,
      params,
      binding.params
    )
    owner.stoppedGuard = {
      error,
      evidence: {
        origin: 'scripted-complete-params',
        requested,
        resolved: name,
        method: binding.method,
        frameId: binding.id,
        expected: captureValue(params),
        actual: captureValue(binding.params),
        expectedOwnKeys: params !== null && typeof params === 'object' ? Object.keys(params) : [],
        actualOwnKeys:
          binding.params !== null && typeof binding.params === 'object'
            ? Object.keys(binding.params)
            : [],
        completed: binding.completed,
        replyIssued: false
      }
    }
    throw error
  }
  let resolved: boolean
  if (rejection) {
    const error =
      rejection.category === 'TypeError'
        ? new TypeError(rejection.message)
        : new Error(rejection.message)
    if (rejection.deliveryUnknown) {
      markRpcDeliveryUnknown(error)
    }
    // Resolve the physical tracker to cancel its deadline before injecting the scripted rejection.
    owner.rejects.get(name)?.(error)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario asked for a null result, which is a reply shape a host can send.
    resolved = owner.tracker.resolve({ id: binding.id, ok: true, result: null } as RpcResponse)
  } else {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the reply as JSON; the wire id is the transport’s.
    resolved = owner.tracker.resolve({ ...(reply as object), id: binding.id } as RpcResponse)
  }
  binding.completed = true
  if (owner.causality.isBridgeChild(binding.child)) {
    binding.child.completion = {
      ordinal: owner.nextWriteOrdinal(),
      reply: captureValue(reply),
      resolved
    }
  }
  if (!resolved) {
    throw new Error(`Actual request already terminated: ${name}`)
  }
  for (const [aliasName, target] of owner.aliases) {
    if (target === name) {
      owner.aliases.delete(aliasName)
    }
  }
}

export function scriptedLateReply(
  owner: ScriptedRpcTransport,
  name: string,
  reply: unknown
): boolean {
  return owner.fault.capture('explicit late reply', () => {
    const binding = owner.bindings.get(name)
    if (!binding || binding.child.settlement.status === 'pending') {
      throw new Error('Late reply requires an actually terminated request')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the explicit test supplies response fields and this binding supplies the actual physical ID.
    const resolved = owner.tracker.resolve({ ...(reply as object), id: binding.id } as RpcResponse)
    if (resolved) {
      throw new Error('Late reply unexpectedly resolved a live request')
    }
    ;(binding.child.lateReplies ??= []).push({
      ordinal: owner.nextWriteOrdinal(),
      reply: captureValue(reply),
      resolved: false
    })
    return resolved
  })
}
