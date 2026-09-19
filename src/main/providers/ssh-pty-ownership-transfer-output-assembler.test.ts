import { describe, expect, it } from 'vitest'
import type { SshPtyDataCallback } from './ssh-pty-provider-contract'
import { SshPtyOwnershipTransferOutputAssembler } from './ssh-pty-ownership-transfer-output-assembler'

type Payload = Parameters<SshPtyDataCallback>[0]

function fragment(
  data: string,
  start: number,
  end: number,
  options: Partial<Payload> & { providerGeneration?: number } = {}
): Payload {
  const providerGeneration = options.providerGeneration ?? 1
  return {
    id: 'ssh:connection-1@@pty-1',
    data,
    providerGeneration,
    ptyIncarnation: 'incarnation-1',
    source: {
      relayPtyId: 'pty-1',
      spanId: `token-1:${start}:${end}`,
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1',
      sourceStartSu: start,
      sourceEndSu: end,
      ownershipTransfer: {
        version: 1,
        bridgeId: 'bridge-1',
        terminalId: 'pty-1',
        incarnationId: 'incarnation-1',
        ownerLease: 'lease-1',
        sourceOwnerGeneration: 3,
        destinationRuntimeId: 'runtime-1',
        frameSeq: 7,
        fragmentStartSu: start,
        fragmentEndSu: end,
        frameLengthSu: 5
      }
    },
    ...options
  }
}

describe('SshPtyOwnershipTransferOutputAssembler', () => {
  it('assembles contiguous fragments without exposing partial output', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()

    expect(assembler.accept(fragment('he', 0, 2))).toBeNull()
    expect(assembler.accept(fragment('llo', 2, 5))).toEqual({ seq: 7, data: 'hello' })
  })

  it('replaces an incomplete frame only for a newer provider generation', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()
    expect(assembler.accept(fragment('he', 0, 2))).toBeNull()
    expect(assembler.accept(fragment('hello', 0, 5, { providerGeneration: 2 }))).toEqual({
      seq: 7,
      data: 'hello'
    })

    expect(() => assembler.accept(fragment('llo', 2, 5))).toThrow(
      'pty_ownership_transfer_output_stale_generation'
    )
  })

  it('rejects a changed delivery fence after a frame is complete', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()
    expect(assembler.accept(fragment('hello', 0, 5))).toEqual({ seq: 7, data: 'hello' })

    const stale = fragment('hello', 0, 5)
    expect(() =>
      assembler.accept({
        ...stale,
        source: { ...stale.source!, deliveryToken: 'changed-token' }
      })
    ).toThrow('pty_ownership_transfer_output_stale_generation')
  })

  it('accepts a newer client activation and fences the predecessor', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()
    const old = fragment('old', 0, 3)
    const oldPayload = {
      ...old,
      source: {
        ...old.source!,
        ownershipTransfer: { ...old.source!.ownershipTransfer!, frameLengthSu: 3 }
      }
    }
    expect(assembler.accept(oldPayload)).toEqual({ seq: 7, data: 'old' })

    const next = fragment('new', 0, 3)
    const nextPayload = {
      ...next,
      source: {
        ...next.source!,
        ownershipTransfer: { ...next.source!.ownershipTransfer!, frameLengthSu: 3 }
      }
    }
    expect(
      assembler.accept({
        ...nextPayload,
        source: {
          ...nextPayload.source!,
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'token-2'
        }
      })
    ).toEqual({ seq: 7, data: 'new' })

    const stale = oldPayload
    expect(() => assembler.accept(stale)).toThrow('pty_ownership_transfer_output_stale_generation')
  })

  it('fails closed on mid-frame recovery and changed delivery identity', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()
    expect(() => assembler.accept(fragment('llo', 2, 5))).toThrow(
      'pty_ownership_transfer_output_fragment_start_invalid'
    )
    expect(assembler.accept(fragment('he', 0, 2))).toBeNull()
    expect(() =>
      assembler.accept({
        ...fragment('llo', 2, 5),
        source: { ...fragment('llo', 2, 5).source!, deliveryToken: 'changed-token' }
      })
    ).toThrow('pty_ownership_transfer_output_fragment_conflict')
  })

  it('bounds complete and partial frames by destination byte capacity', () => {
    const assembler = new SshPtyOwnershipTransferOutputAssembler()
    const oversized = 'x'.repeat(16 * 1024 + 1)
    const base = fragment(oversized, 0, oversized.length)
    const payload = {
      ...base,
      source: {
        ...base.source!,
        ownershipTransfer: {
          ...base.source!.ownershipTransfer!,
          frameLengthSu: oversized.length
        }
      }
    }

    expect(() => assembler.accept(payload)).toThrow('pty_ownership_transfer_output_frame_too_large')
  })
})
