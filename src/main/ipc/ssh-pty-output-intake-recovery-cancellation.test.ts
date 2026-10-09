import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSshPtyOutputIntakeHarness as createHarness,
  sshPtyOutputEvent as event
} from './ssh-pty-output-intake-test-harness'
import { SSH_PTY_ACK_FLUSH_MS } from './ssh-pty-source-ack-coalescer'

const EXIT_EVENT = { id: 'pty-1', code: -1, providerGeneration: 1, ptyIncarnation: 'incarnation-1' }

// #24367: a canceled recovery delivery left a published projection whose span the ledger had
// already released, so every later renderer ACK threw and the next delivery was never credited.
describe('SshPtyOutputIntake recovery cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps crediting the next delivery after a recovery cancellation reclaims a published span', async () => {
    vi.useFakeTimers()
    const { harness, credited } = await cancelPublishedRecoverySpan()
    const next = harness.intake.acceptData(
      event({
        data: 'bbbb',
        source: {
          spanId: 'next-span',
          clientGeneration: 2,
          ownerGeneration: 3,
          deliveryToken: 'next-token',
          sourceStartSu: 0,
          sourceEndSu: 4
        }
      })
    )
    harness.completions[1]!.resolve()
    const nextReceipt = await next
    harness.intake.publishProjectionPrefix(
      [nextReceipt.projection.identity.projectionSemanticsId],
      4,
      4
    )

    // The renderer parses the canceled span first; that ACK is owed to nobody.
    expect(() => harness.intake.settleProjectionPrefix('pty-1', 4)).not.toThrow()
    await vi.advanceTimersByTimeAsync(SSH_PTY_ACK_FLUSH_MS)
    expect(credited).toEqual([])

    expect(() => harness.intake.settleProjectionPrefix('pty-1', 4)).not.toThrow()
    await vi.advanceTimersByTimeAsync(SSH_PTY_ACK_FLUSH_MS)
    expect(credited).toEqual(['next-token@4'])
    expect(harness.intake.getDebugSnapshot().projection.records).toBe(0)
  })

  it('transfers a canceled span without throwing when the renderer drops it', async () => {
    vi.useFakeTimers()
    const { harness } = await cancelPublishedRecoverySpan()

    expect(() => harness.intake.transferPtyProjections('pty-1', 'renderer-destroyed')).not.toThrow()
    expect(harness.intake.getDebugSnapshot().projection.records).toBe(0)
  })

  it('closes the generation while a canceled span is still unACKed', async () => {
    vi.useFakeTimers()
    const { harness, credited } = await cancelPublishedRecoverySpan()

    expect(() => harness.intake.closeGeneration(1, 'provider-closed')).not.toThrow()
    await vi.advanceTimersByTimeAsync(SSH_PTY_ACK_FLUSH_MS)

    expect(harness.intake.getDebugSnapshot()).toMatchObject({
      projection: { records: 0 },
      source: { openedTokens: 0, ptyIdentities: 0 }
    })
    expect(credited).toEqual([])
  })

  it('accepts a recovery span whose model admission finishes after the cancellation', async () => {
    const harness = createHarness()
    const recovered = harness.intake.acceptData(event({ source: recoverySource() }))
    await vi.waitFor(() => expect(harness.completions).toHaveLength(1))
    harness.intake.applySourceRecoveryCancellationProof(EXIT_EVENT, {
      sentEndSu: 8,
      creditedEndSu: 4
    })
    harness.completions[0]!.resolve()

    await expect(recovered).resolves.toMatchObject({ sequence: 4 })
  })
})

async function cancelPublishedRecoverySpan() {
  const credited: string[] = []
  const harness = createHarness({
    publishSourceAck: (_providerGeneration, batch, onSettled) => {
      for (const ack of batch.acknowledgements) {
        credited.push(`${ack.deliveryToken}@${ack.creditedEndSu}`)
      }
      onSettled({ ok: true })
    }
  })
  const recovered = harness.intake.acceptData(event({ source: recoverySource() }))
  harness.completions[0]!.resolve()
  const receipt = await recovered
  // Sent to the renderer, not yet parsed.
  harness.intake.publishProjectionPrefix([receipt.projection.identity.projectionSemanticsId], 4, 4)
  harness.intake.applySourceRecoveryCancellationProof(EXIT_EVENT, {
    sentEndSu: 8,
    creditedEndSu: 4
  })
  return { harness, credited }
}

function recoverySource() {
  return {
    spanId: 'recovery-span',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'recovery-token',
    sourceStartSu: 4,
    sourceEndSu: 8
  }
}
