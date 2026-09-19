import { vi } from 'vitest'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'

export function liveSourceCaptureFixture(
  profileDirectory: string,
  identity: PtyOwnershipTransferWireIdentity
) {
  const model = {
    version: 1 as const,
    identity,
    throughSeq: 1,
    modelSequenceEnd: 100,
    modelData: 'one🙂',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1 as const, pendingEscapeTailAnsi: '\x1b[' }
  }
  const boundary = {
    version: 1,
    identity,
    throughSeq: 1,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      ownerGeneration: identity.sourceOwnerGeneration,
      clientGeneration: 1,
      providerGeneration: 1,
      deliveryToken: 'capture',
      state: 'active',
      windowSu: 1024,
      receivedEndSu: 5,
      sentEndSu: 5,
      creditedEndSu: 5,
      generationClosed: false,
      exitPublished: false
    }
  }
  const provider = {
    drainOutgoingSourceControls: vi.fn(async () => {}),
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity: () => identity,
    getOwnershipBridgeCapabilities: async () => ({
      liveTransfer: true,
      destinationDelegationVersion: 1,
      preparationShutdownGuardVersion: 1,
      transferGraceGuardVersion: 1,
      transferLifecycleGuardVersion: 1,
      captureBoundaryVersion: 1,
      captureSelectionVersion: 1
    }),
    requestHostRpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === PTY_OWNERSHIP_TRANSFER_METHODS.prepare) {
        return { ...params, phase: 'prepared', sourceOutputEndSeq: 1, replayStartSeq: 1 }
      }
      if (method === PTY_OWNERSHIP_CAPTURE_METHODS.begin) {
        return { version: 1, captureToken: 'capture' }
      }
      if (method === PTY_OWNERSHIP_CAPTURE_METHODS.inspect) {
        return { version: 1, boundary }
      }
      if (method === PTY_OWNERSHIP_CAPTURE_METHODS.select) {
        const saved = new OrcadOutgoingCaptureStore(profileDirectory).read(identity)
        if (!saved || JSON.stringify(saved.selection) !== JSON.stringify(params.baseline)) {
          throw new Error('capture must be persisted before selection')
        }
        return { version: 1, baseline: params.baseline }
      }
      if (method === PTY_OWNERSHIP_CAPTURE_METHODS.release) {
        return { version: 1, released: true }
      }
      throw new Error(`unexpected source method:${method}`)
    })
  }
  return { provider, model, serializeSshPtyOwnershipCapture: vi.fn(async () => model) }
}
