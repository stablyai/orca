import { describe, expect, it, vi } from 'vitest'
import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-output-source-obligations'
import {
  createSshPtyOutputIntakeHarness as createHarness,
  sshPtyOutputEvent as event
} from './ssh-pty-output-intake-test-harness'

const ownershipTransfer = {
  bridgeId: 'bridge-1',
  terminalId: 'relay-pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1',
  version: 1 as const,
  frameSeq: 1,
  fragmentStartSu: 0,
  fragmentEndSu: 4,
  frameLengthSu: 4
}

function sourceRange(providerGeneration: number): SshPtyOwnershipTransferSourceRange {
  return {
    providerGeneration,
    relayPtyId: 'relay-pty-1',
    spanId: 'token-1:0:4',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token-1',
    ptyIncarnation: 'incarnation-1',
    sourceStartSu: 0,
    sourceEndSu: 4,
    ownershipTransfer
  }
}

function source() {
  return {
    relayPtyId: 'relay-pty-1',
    spanId: 'token-1:0:4',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token-1',
    sourceStartSu: 0,
    sourceEndSu: 4,
    ownershipTransfer
  }
}

describe('SshPtyOutputIntake ownership-transfer settlement ordering', () => {
  it('holds an early destination receipt until quarantined source data is admitted', async () => {
    vi.useFakeTimers()
    const batches: unknown[] = []
    const harness = createHarness(
      {
        publishSourceAck: (_generation, batch, onSettled) => {
          batches.push(batch)
          onSettled({ ok: true })
        }
      },
      { ownershipTransferOutputEnabled: true }
    )
    harness.intake.settleOwnershipTransferOutput(sourceRange(1))
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 1
    })

    const dataReceipt = harness.intake.acceptData(event({ source: source() }))
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 0
    })
    harness.completions[0]!.resolve()
    const receipt = await dataReceipt
    const projectionId = receipt.projection.identity.projectionSemanticsId
    harness.intake.publishProjectionPrefix([projectionId], 4, 4)
    harness.intake.settleProjectionPrefix('pty-1', 4)
    await vi.advanceTimersByTimeAsync(8)

    expect(batches).toEqual([{ acknowledgements: [expect.objectContaining({ creditedEndSu: 4 })] }])
    vi.useRealTimers()
  })

  it('clears an unadmitted receipt without credit and fences it from the next generation', async () => {
    vi.useFakeTimers()
    const batches: unknown[] = []
    const harness = createHarness(
      {
        publishSourceAck: (_generation, batch, onSettled) => {
          batches.push(batch)
          onSettled({ ok: true })
        }
      },
      { ownershipTransferOutputEnabled: true }
    )
    harness.intake.settleOwnershipTransferOutput(sourceRange(1))
    harness.intake.closeGeneration(1, 'reconnect')
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 0
    })

    const dataReceipt = harness.intake.acceptData(
      event({ providerGeneration: 2, source: source() })
    )
    harness.completions[0]!.resolve()
    const receipt = await dataReceipt
    const projectionId = receipt.projection.identity.projectionSemanticsId
    harness.intake.publishProjectionPrefix([projectionId], 4, 4)
    harness.intake.settleProjectionPrefix('pty-1', 4)
    await vi.advanceTimersByTimeAsync(8)

    expect(batches).toEqual([])
    vi.useRealTimers()
  })

  it('drops a destination receipt that arrives after its generation closed', () => {
    const harness = createHarness({}, { ownershipTransferOutputEnabled: true })

    harness.intake.closeGeneration(1, 'reconnect')
    harness.intake.settleOwnershipTransferOutput(sourceRange(1))

    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 0
    })
  })

  it('treats duplicate durable receipts as idempotent before and after admission', async () => {
    const harness = createHarness({}, { ownershipTransferOutputEnabled: true })
    const receipt = sourceRange(1)
    harness.intake.settleOwnershipTransferOutput(receipt)
    harness.intake.settleOwnershipTransferOutput(receipt)
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 1
    })

    const dataReceipt = harness.intake.acceptData(event({ source: source() }))
    harness.intake.settleOwnershipTransferOutput(receipt)
    harness.completions[0]!.resolve()
    await dataReceipt

    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 0
    })
  })

  it('preserves the receipt when synchronous model admission rolls the span back', async () => {
    let attempt = 0
    let finishModel!: () => void
    const modelCompletion = new Promise<void>((resolve) => {
      finishModel = resolve
    })
    const harness = createHarness(
      {
        acceptModel: () => {
          attempt += 1
          if (attempt === 1) {
            throw new Error('model admission failed')
          }
          return { sequence: 4, completion: modelCompletion }
        }
      },
      { ownershipTransferOutputEnabled: true }
    )
    harness.intake.settleOwnershipTransferOutput(sourceRange(1))

    await expect(harness.intake.acceptData(event({ source: source() }))).rejects.toThrow(
      'model admission failed'
    )
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 1
    })

    const retry = harness.intake.acceptData(event({ source: source() }))
    expect(harness.intake.getDebugSnapshot().source).toMatchObject({
      pendingOwnershipTransferSettlements: 0
    })
    finishModel()
    await expect(retry).resolves.toMatchObject({ ptyId: 'pty-1' })
  })
})
