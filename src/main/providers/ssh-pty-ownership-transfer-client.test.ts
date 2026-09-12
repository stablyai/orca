import { describe, expect, it, vi } from 'vitest'
import { SshPtyOwnershipTransferClient } from './ssh-pty-ownership-transfer-client'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../../shared/pty-ownership-transfer-wire'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime-1'
} as const

function prepareResult() {
  return {
    ...identity,
    version: 1,
    phase: 'prepared' as const,
    sourceOutputEndSeq: 0,
    replayStartSeq: 1
  }
}

function statusResult() {
  return {
    ...identity,
    version: 1,
    phase: 'committed' as const,
    sourceOutputEndSeq: 3,
    replayStartSeq: 1,
    acceptedSourceEndSeq: 3,
    acceptedInputIds: 0,
    commitReceipt: {
      receiptId: 'receipt-1',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 3,
      committedAt: '2026-08-31T00:00:00.000Z'
    }
  }
}

describe('SshPtyOwnershipTransferClient', () => {
  it('routes prepare and strictly decodes the response', async () => {
    const request = vi.fn().mockResolvedValue(prepareResult())
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.prepare({ ...identity, version: 1 }, { timeoutMs: 1234 })).resolves.toEqual(
      prepareResult()
    )
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
      { ...identity, version: 1 },
      { timeoutMs: 1234 }
    )
  })

  it('rejects malformed and phase-conflicting responses before callers can use them', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...prepareResult(), sourceOutputEndSeq: -1 })
      .mockResolvedValueOnce({ ...prepareResult(), phase: 'committed' })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.prepare({ ...identity, version: 1 })).rejects.toThrow()
    await expect(client.prepare({ ...identity, version: 1 })).rejects.toThrow()
  })

  it('rejects a validly shaped response for a different bridge identity', async () => {
    const request = vi.fn().mockResolvedValue({
      ...prepareResult(),
      bridgeId: 'other-bridge'
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.prepare({ ...identity, version: 1 })).rejects.toThrow(
      'pty_ownership_transfer_response_identity_mismatch'
    )
  })

  it('decodes attachment-fenced post-commit replay without weakening prepared replay', async () => {
    const request = vi.fn().mockResolvedValue({
      ...identity,
      version: 1,
      phase: 'published',
      attachmentId: 'attachment-rekeyed',
      frames: [{ seq: 4, data: 'retained' }],
      sourceOutputEndSeq: 4,
      replayStartSeq: 1
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(
      client.replay({
        ...identity,
        version: 1,
        afterSeq: 3,
        attachmentId: 'attachment-rekeyed'
      })
    ).resolves.toMatchObject({
      phase: 'published',
      attachmentId: 'attachment-rekeyed',
      frames: [{ seq: 4, data: 'retained' }]
    })
  })

  it('decodes input and abort results without trusting arbitrary fields', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, duplicate: false, ignored: 'field' })
      .mockResolvedValueOnce({ version: 1, phase: 'aborted', ignored: true })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(
      client.input({ ...identity, version: 1, inputId: 'input-1', data: 'ls\n' })
    ).resolves.toEqual({ accepted: true, duplicate: false })
    await expect(client.abort({ ...identity, version: 1 })).resolves.toEqual({
      version: 1,
      phase: 'aborted'
    })
  })

  it('probes status through the additive recovery method', async () => {
    const exit = {
      verdict: 'exited' as const,
      eventId: 'bridge-1:exit',
      observedAt: '2026-08-31T00:00:01.000Z',
      code: 0
    }
    const request = vi.fn().mockResolvedValue({ ...statusResult(), exit, ignored: true })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.status({ ...identity, version: 1 })).resolves.toMatchObject({
      phase: 'committed',
      acceptedSourceEndSeq: 3,
      commitReceipt: expect.objectContaining({ receiptId: 'receipt-1' }),
      exit
    })
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.status,
      { ...identity, version: 1 },
      undefined
    )
  })

  it('rejects status snapshots whose phase and receipts disagree', async () => {
    const request = vi.fn().mockResolvedValue({
      ...statusResult(),
      commitReceipt: undefined
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.status({ ...identity, version: 1 })).rejects.toThrow(
      'pty_ownership_transfer_status_result_commit_phase_invalid'
    )
  })

  it('rejects malformed authoritative exit evidence in a status snapshot', async () => {
    const request = vi.fn().mockResolvedValue({
      ...statusResult(),
      exit: {
        verdict: 'exited',
        eventId: 'bridge-1:exit',
        observedAt: 'not-a-date'
      }
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    await expect(client.status({ ...identity, version: 1 })).rejects.toThrow(
      'pty_ownership_transfer_exit_invalid'
    )
  })

  it('keeps exit evidence absent for a mixed-version status snapshot', async () => {
    const request = vi.fn().mockResolvedValue(statusResult())
    const client = new SshPtyOwnershipTransferClient({ request } as never)

    const status = await client.status({ ...identity, version: 1 })
    expect(status).not.toHaveProperty('exit')
  })

  it('requires explicit destination output support before attaching', async () => {
    const request = vi.fn().mockResolvedValue({
      ...identity,
      version: 1,
      phase: 'committed',
      attachmentId: 'attachment-1',
      executionVerdict: 'live'
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationControl: true,
      authoritativeExit: true
    } as const
    const attachment = { ...identity, version: 1 as const, attachmentId: 'attachment-1' }

    await expect(client.attachDestination(attachment, capabilities)).rejects.toThrow(
      'pty_ownership_transfer_destination_routing_unsupported'
    )
    expect(request).not.toHaveBeenCalled()
    await expect(
      client.attachDestination(attachment, { ...capabilities, destinationOutput: true })
    ).resolves.toMatchObject({ attachmentId: 'attachment-1', executionVerdict: 'live' })
  })

  it('rejects an attachment response for another reconnect attempt', async () => {
    const request = vi.fn().mockResolvedValue({
      ...identity,
      version: 1,
      phase: 'committed',
      attachmentId: 'attachment-stale',
      executionVerdict: 'live'
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true
    } as const

    await expect(
      client.attachDestination(
        { ...identity, version: 1, attachmentId: 'attachment-current' },
        capabilities
      )
    ).rejects.toThrow('pty_ownership_transfer_response_identity_mismatch')
  })

  it('fails closed before reconnect rekey is explicitly negotiated', async () => {
    const request = vi.fn()
    const client = new SshPtyOwnershipTransferClient({ request } as never)
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true
    } as const
    const rekey = {
      ...identity,
      version: 1 as const,
      previousReconnectGeneration: 1,
      reconnectGeneration: 2,
      attachmentId: 'attachment-2'
    }

    await expect(client.rekeyReconnect(rekey, capabilities)).rejects.toThrow(
      'pty_ownership_transfer_reconnect_rekey_unsupported'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('routes and strictly fences a negotiated reconnect rekey', async () => {
    const rekey = {
      ...identity,
      version: 1 as const,
      previousReconnectGeneration: 1,
      reconnectGeneration: 2,
      attachmentId: 'attachment-2'
    }
    const request = vi
      .fn()
      .mockResolvedValue({ ...rekey, phase: 'committed', executionVerdict: 'live', ignored: true })
    const client = new SshPtyOwnershipTransferClient({ request } as never)
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true
    } as const

    await expect(client.rekeyReconnect(rekey, capabilities)).resolves.toEqual({
      ...rekey,
      phase: 'committed',
      executionVerdict: 'live'
    })
    expect(request).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect,
      rekey,
      undefined
    )
  })

  it('rejects a rekey response for another reconnect generation', async () => {
    const rekey = {
      ...identity,
      version: 1 as const,
      previousReconnectGeneration: 1,
      reconnectGeneration: 2,
      attachmentId: 'attachment-2'
    }
    const request = vi.fn().mockResolvedValue({
      ...rekey,
      phase: 'committed',
      executionVerdict: 'live',
      reconnectGeneration: 3
    })
    const client = new SshPtyOwnershipTransferClient({ request } as never)
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true
    } as const

    await expect(client.rekeyReconnect(rekey, capabilities)).rejects.toThrow(
      'pty_ownership_transfer_response_identity_mismatch'
    )
  })
})
