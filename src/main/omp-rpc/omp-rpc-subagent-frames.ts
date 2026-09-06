// Validation for the three forwarded subagent frames.
//
// Stricter than the D3 floor the other lifecycle frames get, because the roster
// keys on these fields: `id`/`index`/`agent`/`status` are what identify a
// subagent and order it, so a frame missing one cannot be projected at all —
// admitting it would produce an `undefined` roster row rather than a rendering
// gap. Everything past those fields still passes through untouched.

import type {
  OmpRpcSubagentEventFrame,
  OmpRpcSubagentLifecycleFrame,
  OmpRpcSubagentProgressFrame
} from '../../shared/omp-rpc-subagent-protocol'
import {
  OMP_RPC_SUBAGENT_LIFECYCLE_STATUSES,
  OMP_RPC_SUBAGENT_STATUSES
} from '../../shared/omp-rpc-subagent-protocol'
import { isOmpRpcObject } from './omp-rpc-frame-validation'

function isIdentified(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.agent === 'string' &&
    Number.isSafeInteger(payload.index) &&
    (payload.index as number) >= 0
  )
}

export function parseOmpRpcSubagentLifecycleFrame(
  frame: unknown
): OmpRpcSubagentLifecycleFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'subagent_lifecycle') {
    return null
  }
  const payload = frame.payload
  if (
    !isOmpRpcObject(payload) ||
    typeof payload.id !== 'string' ||
    !isIdentified(payload) ||
    !OMP_RPC_SUBAGENT_LIFECYCLE_STATUSES.includes(
      payload.status as OmpRpcSubagentLifecycleFrame['payload']['status']
    )
  ) {
    return null
  }
  return frame as OmpRpcSubagentLifecycleFrame
}

export function parseOmpRpcSubagentProgressFrame(
  frame: unknown
): OmpRpcSubagentProgressFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'subagent_progress') {
    return null
  }
  const payload = frame.payload
  if (!isOmpRpcObject(payload) || !isIdentified(payload) || typeof payload.task !== 'string') {
    return null
  }
  const progress = payload.progress
  if (
    !isOmpRpcObject(progress) ||
    typeof progress.id !== 'string' ||
    !OMP_RPC_SUBAGENT_STATUSES.includes(
      progress.status as OmpRpcSubagentProgressFrame['payload']['progress']['status']
    )
  ) {
    return null
  }
  return frame as OmpRpcSubagentProgressFrame
}

/** The inner event is the parent session's own union and stays untyped; only
 *  the subagent attribution is checked, since that is what a consumer routes on. */
export function parseOmpRpcSubagentEventFrame(frame: unknown): OmpRpcSubagentEventFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'subagent_event') {
    return null
  }
  const payload = frame.payload
  if (
    !isOmpRpcObject(payload) ||
    typeof payload.id !== 'string' ||
    !isOmpRpcObject(payload.event) ||
    typeof payload.event.type !== 'string'
  ) {
    return null
  }
  return frame as OmpRpcSubagentEventFrame
}
