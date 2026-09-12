import { describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipTransferDestinationPublicationRequest } from '../../../shared/pty-ownership-transfer-destination-adapter'
import {
  PtyOwnershipTransferSurfacePublicationCoordinator,
  PtyOwnershipTransferSurfacePublicationError,
  type PtyOwnershipTransferSurfacePublicationState
} from './pty-ownership-transfer-surface-publication'

const request: PtyOwnershipTransferDestinationPublicationRequest = {
  identity: {
    bridgeId: 'bridge-1',
    terminalId: 'terminal-1',
    incarnationId: 'incarnation-1',
    ownerLease: 'lease-1',
    sourceOwnerGeneration: 3,
    destinationRuntimeId: 'runtime-1'
  },
  surfaceBinding: {
    executionHostId: 'local',
    workspaceKey: 'folder:folder-1',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    ptyId: 'terminal-1'
  },
  frames: [
    { seq: 1, data: 'first\n' },
    { seq: 2, data: 'second\n' }
  ],
  publicationReceipt: {
    version: 1,
    publicationReceiptId: 'publication-1',
    bridgeId: 'bridge-1',
    destinationRuntimeId: 'runtime-1',
    commitReceipt: {
      receiptId: 'commit-1',
      bridgeId: 'bridge-1',
      acceptedSourceEndSeq: 2,
      committedAt: '2026-08-30T12:01:00.000Z'
    },
    publishedAt: '2026-08-30T12:02:00.000Z',
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey: 'folder:folder-1',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'terminal-1'
    }
  }
}

describe('PtyOwnershipTransferSurfacePublicationCoordinator', () => {
  it('publishes once and recovers the exact durable receipt without republishing', () => {
    let state: PtyOwnershipTransferSurfacePublicationState = 'absent'
    const publishDurably = vi.fn(() => {
      state = 'published'
    })
    const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator({
      inspectDurablePublication: () => state,
      publishDurably
    })
    expect(coordinator.publish(request)).toEqual(request.publicationReceipt)
    expect(coordinator.publish(request)).toEqual(request.publicationReceipt)
    expect(publishDurably).toHaveBeenCalledOnce()
  })

  it('refuses an occupied surface and a publication that cannot be re-read durably', () => {
    const conflictPublisher = vi.fn()
    const conflict = new PtyOwnershipTransferSurfacePublicationCoordinator({
      inspectDurablePublication: () => 'conflict',
      publishDurably: conflictPublisher
    })
    expect(() => conflict.publish(request)).toThrow(
      expect.objectContaining({ reason: 'surface-conflict' })
    )
    expect(conflictPublisher).not.toHaveBeenCalled()

    const missing = new PtyOwnershipTransferSurfacePublicationCoordinator({
      inspectDurablePublication: () => 'absent',
      publishDurably: vi.fn()
    })
    expect(() => missing.publish(request)).toThrow(
      expect.objectContaining({ reason: 'publication-unverified' })
    )
  })

  it('rejects a changed binding, truncated replay, or incomplete commit cursor', () => {
    const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator({
      inspectDurablePublication: () => 'published',
      publishDurably: vi.fn()
    })
    const candidates: PtyOwnershipTransferDestinationPublicationRequest[] = [
      {
        ...request,
        surfaceBinding: { ...request.surfaceBinding, workspaceKey: 'worktree:repo::/workspace' }
      },
      { ...request, frames: [{ seq: 1, data: 'partial', truncated: true }] },
      { ...request, frames: [{ seq: 1, data: 'first\n' }] },
      {
        ...request,
        frames: [
          { seq: 2, data: 'first\n' },
          { seq: 3, data: 'second\n' }
        ],
        publicationReceipt: {
          ...request.publicationReceipt,
          commitReceipt: { ...request.publicationReceipt.commitReceipt, acceptedSourceEndSeq: 3 }
        }
      }
    ]
    for (const candidate of candidates) {
      expect(() => coordinator.publish(candidate)).toThrow(
        PtyOwnershipTransferSurfacePublicationError
      )
    }
  })
})
