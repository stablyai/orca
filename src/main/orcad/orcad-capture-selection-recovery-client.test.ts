import { expect, it, vi } from 'vitest'
import { recoverOrcadSourceCaptureSelection } from './orcad-capture-selection-recovery-client'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'

const capabilities = {
  protocolVersions: [1],
  maxReplayBytes: 1024,
  maxInputIds: 100,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationDelegationVersion: 1,
  captureBoundaryVersion: 1,
  captureSelectionVersion: 1,
  captureSelectionRecoveryVersion: 1
}
const baseline = {
  version: 1,
  modelSha256: 'a'.repeat(64),
  boundary: {
    version: 1,
    identity,
    throughSeq: 0,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      ownerGeneration: identity.sourceOwnerGeneration,
      providerGeneration: 1,
      clientGeneration: 1,
      deliveryToken: 'saved',
      state: 'active',
      windowSu: 1024,
      receivedEndSu: 0,
      sentEndSu: 0,
      creditedEndSu: 0,
      generationClosed: false,
      exitPublished: false
    }
  }
}
it('negotiates support before sending exact proof and baseline', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(capabilities)
    .mockResolvedValueOnce({ version: 1, baseline })
  await expect(recoverOrcadSourceCaptureSelection(transport, request(), baseline)).resolves.toEqual(
    baseline
  )
  expect(transport.mock.calls[0][0]).toBe('pty.getOwnershipBridgeCapabilities')
  expect(transport.mock.calls[1]).toEqual([
    PTY_OWNERSHIP_CAPTURE_METHODS.recoverSelection,
    {
      version: 1,
      proof: expect.objectContaining({ credential: request().credential }),
      baseline
    },
    undefined
  ])
})
it.each([undefined, 2])('does not send recovery to an unsupported peer (%s)', async (version) => {
  const transport = vi
    .fn()
    .mockResolvedValue({ ...capabilities, captureSelectionRecoveryVersion: version })
  await expect(recoverOrcadSourceCaptureSelection(transport, request(), baseline)).rejects.toThrow(
    'unsupported'
  )
  expect(transport).toHaveBeenCalledOnce()
})
it('refuses a mismatched selection reply', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(capabilities)
    .mockResolvedValueOnce({ version: 1, baseline: { ...baseline, modelSha256: 'b'.repeat(64) } })
  await expect(recoverOrcadSourceCaptureSelection(transport, request(), baseline)).rejects.toThrow(
    'reply_mismatch'
  )
})
it('does not mutate after cancellation during negotiation', async () => {
  const controller = new AbortController()
  const transport = vi.fn().mockImplementation(async () => {
    controller.abort()
    return capabilities
  })
  await expect(
    recoverOrcadSourceCaptureSelection(transport, request(), baseline, {
      signal: controller.signal
    })
  ).rejects.toThrow()
  expect(transport).toHaveBeenCalledOnce()
})
