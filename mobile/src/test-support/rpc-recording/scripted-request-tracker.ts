import type { NativeObservation } from './recording-causality'
import { buildDirectRpcWireRequest } from '../../transport/rpc-envelope-fields'
import { RpcClientRequestTracker } from '../../transport/rpc-client-request-tracker'
import { captureError } from './recording-values'

import type { ScriptedRpcTransport } from './scripted-rpc-transport'
import { DEVICE_TOKEN } from './scripted-rpc-device'

export function scriptedNextFrameId(owner: ScriptedRpcTransport): string {
  return `frame-${++owner.frameCount}`
}

export function scriptedOccurrence(owner: ScriptedRpcTransport, method: string): string {
  const next = (owner.counts.get(method) ?? 0) + 1
  owner.counts.set(method, next)
  return `${method}#${next}`
}

export function scriptedPublish(
  owner: ScriptedRpcTransport,
  name: string,
  value: unknown
): { name: string; ordinal: number; json: string } {
  const emitted = { name, ordinal: owner.nextWriteOrdinal(), json: JSON.stringify(value) }
  owner.payloads.push(emitted)
  return emitted
}

export function createScriptedRequestTracker(owner: ScriptedRpcTransport) {
  return new RpcClientRequestTracker({
    nextId: () => {
      const id = owner.nextFrameId()
      try {
        const child = owner.causality.currentNative()
        if (child.allocation) {
          throw new Error('Actual unary allocation repeated')
        }
        child.allocation = { id, ordinal: owner.nextWriteOrdinal() }
      } catch (error) {
        owner.fault.report('actual unary allocation', error)
      }
      return id
    },
    getState: () => owner.state,
    waitForConnected: async () => {
      let child: NativeObservation | undefined
      try {
        child = owner.causality.currentNative()
        if (child.wait) {
          throw new Error('Actual native connection wait repeated')
        }
        child.wait = { ordinal: owner.nextWriteOrdinal(), startedAt: owner.now() }
      } catch (error) {
        owner.fault.report('actual native wait entry', error)
      }
      try {
        if (owner.waitForConnected) {
          await owner.waitForConnected()
        }
        if (owner.state !== 'connected') {
          throw new Error('Scripted transport disconnected')
        }
        try {
          if (!child?.wait) {
            throw new Error('Missing original connection wait entry')
          }
          child.wait.outcome = {
            status: 'fulfilled',
            ordinal: owner.nextWriteOrdinal(),
            at: owner.now()
          }
        } catch (error) {
          owner.fault.report('actual native wait return', error)
        }
      } catch (error) {
        try {
          if (!child?.wait) {
            throw new Error('Missing original connection wait entry')
          }
          child.wait.outcome = {
            status: 'rejected',
            ordinal: owner.nextWriteOrdinal(),
            at: owner.now(),
            error: captureError(error)
          }
        } catch (observationError) {
          owner.fault.report('actual native wait rejection', observationError)
        }
        throw error
      }
    },
    sendFrame: (frame) => {
      try {
        const child = owner.causality.currentNative()
        if (child.method !== frame.method || child.frame || owner.bindings.has(child.name)) {
          throw new Error('Duplicate or mismatched physical binding')
        }
        const payload = buildDirectRpcWireRequest(frame, DEVICE_TOKEN)
        const json = JSON.stringify(payload)
        const ordinal = owner.nextWriteOrdinal()
        owner.bindings.set(child.name, {
          id: payload.id,
          method: frame.method,
          params: payload.params,
          completed: false,
          child
        })
        child.frame = { id: payload.id, ordinal }
        owner.payloads.push({ name: child.name, ordinal, json })
        return true
      } catch (error) {
        // The real tracker owns false-send pending/deadline cleanup.
        owner.fault.report('physical frame', error)
        return false
      }
    }
  })
}
