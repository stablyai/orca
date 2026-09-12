import { describe, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferDestinationOutputAdmission } from './pty-ownership-transfer-destination-output-admission'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime-1'
} as const

describe('PtyOwnershipTransferDestinationOutputAdmission', () => {
  it('queues multiple frames and settles them in sequence order', async () => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    const accepted: number[] = []
    const second = admission.defer(identity, { seq: 2, data: 'two' })
    const first = admission.defer(identity, { seq: 1, data: 'one' })

    admission.settle(identity, (frame) => accepted.push(frame.seq))

    expect(accepted).toEqual([1, 2])
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('returns the same promise for an idempotent duplicate frame', async () => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    const frame = { seq: 1, data: 'one' }
    const first = admission.defer(identity, frame)
    const duplicate = admission.defer(identity, { ...frame })

    expect(duplicate).toBe(first)
    admission.settle(identity, vi.fn())
    await expect(first).resolves.toBeUndefined()
  })

  it('rejects conflicting duplicate and identity frames', () => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    admission.defer(identity, { seq: 1, data: 'one' })

    expect(() => admission.defer(identity, { seq: 1, data: 'changed' })).toThrow(
      'pty_ownership_transfer_output_admission_conflict'
    )
    expect(() =>
      admission.defer({ ...identity, ownerLease: 'other' }, { seq: 2, data: 'two' })
    ).toThrow('pty_ownership_transfer_output_admission_identity_conflict')
    expect(() =>
      admission.reject({ ...identity, ownerLease: 'other' }, new Error('wrong'))
    ).toThrow('pty_ownership_transfer_output_admission_identity_conflict')
  })

  it('rejects all queued promises when acceptance fails', async () => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    const first = admission.defer(identity, { seq: 1, data: 'one' })
    const second = admission.defer(identity, { seq: 2, data: 'two' })
    const failure = new Error('destination-failed')

    expect(() =>
      admission.settle(identity, () => {
        throw failure
      })
    ).not.toThrow()
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
  })

  it('rejects every queued promise explicitly and enforces the bounded queue', async () => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    const first = admission.defer(identity, { seq: 1, data: 'one' })
    const second = admission.defer(identity, { seq: 2, data: 'two' })
    admission.reject(identity, new Error('recovery-failed'))
    await expect(first).rejects.toThrow('recovery-failed')
    await expect(second).rejects.toThrow('recovery-failed')

    const byFrames = new PtyOwnershipTransferDestinationOutputAdmission({ maxFrames: 2 })
    byFrames.defer(identity, { seq: 1, data: 'x' })
    byFrames.defer(identity, { seq: 2, data: 'x' })
    expect(() => byFrames.defer(identity, { seq: 3, data: 'x' })).toThrow(
      'pty_ownership_transfer_output_admission_backpressure'
    )

    const byBytes = new PtyOwnershipTransferDestinationOutputAdmission({ maxBytes: 4 })
    byBytes.defer(identity, { seq: 1, data: 'xxxx' })
    expect(() => byBytes.defer(identity, { seq: 2, data: 'x' })).toThrow(
      'pty_ownership_transfer_output_admission_backpressure'
    )
  })

  it.each([1, 2, 3])('rejects only the failed suffix at frame %s', async (failedSeq) => {
    const admission = new PtyOwnershipTransferDestinationOutputAdmission()
    const pending = [1, 2, 3].map((seq) => admission.defer(identity, { seq, data: String(seq) }))
    const failure = new Error('destination-failed')
    const accept = vi.fn((frame: { seq: number }) => {
      if (frame.seq === failedSeq) {
        throw failure
      }
    })

    admission.settle(identity, accept)

    expect(accept.mock.calls.map(([frame]) => frame.seq)).toEqual([1, 2, 3].slice(0, failedSeq))
    const settled = await Promise.allSettled(pending)
    expect(settled).toEqual(
      [1, 2, 3].map((seq) =>
        seq < failedSeq
          ? { status: 'fulfilled', value: undefined }
          : { status: 'rejected', reason: failure }
      )
    )
  })
})
