import { randomUUID } from 'node:crypto'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import {
  PTY_OWNERSHIP_CAPTURE_METHODS as methods,
  parsePtyOwnershipCaptureToken
} from '../../shared/pty-ownership-capture-wire'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import {
  parsePtyOwnershipCaptureBaseline,
  type PtyOwnershipCaptureBaseline
} from '../../shared/pty-ownership-capture-baseline'

/** Captures historical model evidence, not permission to commit or retire its source. */
export async function captureSshPtyModelAttempt(options: {
  capabilities: Pick<
    PtyOwnershipBridgeCapabilities,
    'captureBoundaryVersion' | 'captureSelectionVersion'
  >
  selectBaseline?: boolean
  /** Must durably retain and verify exact retry bytes before source selection becomes irreversible. */
  persistBeforeSelection?: (capture: {
    model: ReturnType<typeof parsePtyOwnershipInitialModelSnapshot>
    selection: PtyOwnershipCaptureBaseline
  }) => Promise<void>
  identity: PtyOwnershipTransferWireIdentity
  route: Readonly<{ ptyId: string; providerGeneration: number }>
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  runtime: Pick<OrcaRuntimeService, 'serializeSshPtyOwnershipCapture'>
  signal: AbortSignal
  requestId?: string
}) {
  if (
    options.capabilities.captureBoundaryVersion !== 1 ||
    (options.selectBaseline && options.capabilities.captureSelectionVersion !== 1)
  ) {
    throw new Error('pty_ownership_capture_unsupported')
  }
  if (options.selectBaseline && !options.persistBeforeSelection) {
    throw new Error('pty_ownership_capture_persistence_required')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const route = Object.freeze({ ...options.route })
  options.signal.throwIfAborted()
  const begun = response(
    await options.request(methods.begin, {
      ...identity,
      version: 1,
      requestId: options.requestId ?? randomUUID()
    })
  )
  const captureToken = parsePtyOwnershipCaptureToken(begun.captureToken)
  let failure: unknown
  let failed = false
  let captured:
    | Readonly<{
        boundary: ReturnType<typeof parsePtyOwnershipCaptureBoundary>
        model: ReturnType<typeof parsePtyOwnershipInitialModelSnapshot>
        selection?: PtyOwnershipCaptureBaseline
      }>
    | undefined
  try {
    options.signal.throwIfAborted()
    const inspect = async () => {
      const result = response(await options.request(methods.inspect, { version: 1, captureToken }))
      options.signal.throwIfAborted()
      if (result.boundary === null) {
        throw new Error('pty_ownership_capture_not_ready')
      }
      return parsePtyOwnershipCaptureBoundary(result.boundary, identity)
    }
    const before = await inspect()
    const model = parsePtyOwnershipInitialModelSnapshot(
      await options.runtime.serializeSshPtyOwnershipCapture(before, route, options.signal),
      identity,
      before.throughSeq
    )
    const after = await inspect()
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('pty_ownership_capture_boundary_changed')
    }
    let selection: PtyOwnershipCaptureBaseline | undefined
    if (options.selectBaseline) {
      const baseline = parsePtyOwnershipCaptureBaseline(
        {
          version: 1,
          boundary: before,
          modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, before.throughSeq)
        },
        identity
      )
      await options.persistBeforeSelection!(structuredClone({ model, selection: baseline }))
      options.signal.throwIfAborted()
      const selected = response(
        await options.request(methods.select, { version: 1, captureToken, baseline })
      )
      options.signal.throwIfAborted()
      selection = parsePtyOwnershipCaptureBaseline(selected.baseline, identity)
      if (JSON.stringify(selection) !== JSON.stringify(baseline)) {
        throw new Error('pty_ownership_capture_selection_mismatch')
      }
    }
    captured = Object.freeze({ boundary: before, model, ...(selection ? { selection } : {}) })
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    const released = response(await options.request(methods.release, { version: 1, captureToken }))
    if (released.released !== true) {
      throw new Error('pty_ownership_capture_release_unverified')
    }
  } catch (error) {
    if (failed) {
      throw new AggregateError([failure, error], 'pty_ownership_capture_and_release_failed')
    }
    throw error
  }
  if (failed) {
    throw failure
  }
  return captured!
}

function response(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1
  ) {
    throw new Error('pty_ownership_capture_response_invalid')
  }
  return value as Record<string, unknown>
}
