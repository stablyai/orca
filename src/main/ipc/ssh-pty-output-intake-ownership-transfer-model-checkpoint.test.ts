import { describe, expect, it, vi } from 'vitest'
import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-output-source-obligations'
import {
  createSshPtyOutputIntakeHarness as createHarness,
  sshPtyOutputEvent as event
} from './ssh-pty-output-intake-test-harness'

function transfer(fragmentStartSu = 0, fragmentEndSu = 4) {
  return {
    bridgeId: 'bridge-1',
    terminalId: 'relay-pty-1',
    incarnationId: 'incarnation-1',
    ownerLease: 'lease-1',
    sourceOwnerGeneration: 3,
    destinationRuntimeId: 'runtime-1',
    version: 1 as const,
    frameSeq: 1,
    fragmentStartSu,
    fragmentEndSu,
    frameLengthSu: 4
  }
}

function range(
  spanId = 'token-1:0:4',
  sourceStartSu = 0,
  sourceEndSu = 4,
  fragmentStartSu = 0,
  fragmentEndSu = 4
): SshPtyOwnershipTransferSourceRange {
  return {
    providerGeneration: 1,
    relayPtyId: 'relay-pty-1',
    spanId,
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token-1',
    ptyIncarnation: 'incarnation-1',
    sourceStartSu,
    sourceEndSu,
    ownershipTransfer: transfer(fragmentStartSu, fragmentEndSu)
  }
}

function source(value = range()) {
  return {
    relayPtyId: value.relayPtyId,
    spanId: value.spanId,
    clientGeneration: value.clientGeneration,
    ownerGeneration: value.ownerGeneration,
    deliveryToken: value.deliveryToken,
    sourceStartSu: value.sourceStartSu,
    sourceEndSu: value.sourceEndSu,
    ownershipTransfer: value.ownershipTransfer
  }
}

describe('SshPtyOutputIntake ownership-transfer model checkpoints', () => {
  it('does not release a complete frame before normal model admission is durably checkpointed', async () => {
    const durable = deferred()
    const checkpointOwnershipTransferModel = vi.fn(() => durable.promise)
    const harness = createHarness(
      { checkpointOwnershipTransferModel },
      { ownershipTransferOutputEnabled: true }
    )
    const frameReady = harness.intake.waitForOwnershipTransferModelCheckpoints([range()])
    const ready = vi.fn()
    void frameReady.then(ready)

    const admission = harness.intake.acceptData(event({ source: source() }))
    harness.completions[0]!.resolve()
    await Promise.resolve()

    expect(checkpointOwnershipTransferModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelSequenceEnd: 4 })
    )
    expect(ready).not.toHaveBeenCalled()

    durable.resolve()
    await expect(admission).resolves.toMatchObject({ sequence: 4 })
    await expect(frameReady).resolves.toBeUndefined()
    expect(harness.intake.getDebugSnapshot().ownershipTransferModelCheckpoints).toBe(1)
    harness.intake.settleOwnershipTransferOutput(range())
    expect(harness.intake.getDebugSnapshot().ownershipTransferModelCheckpoints).toBe(0)
  })

  it('joins fragments observed before and after the complete-frame rendezvous', async () => {
    const first = range('token-1:0:2', 0, 2, 0, 2)
    const second = range('token-1:2:4', 2, 4, 2, 4)
    const harness = createHarness({}, { ownershipTransferOutputEnabled: true })

    const firstAdmission = harness.intake.acceptData(
      event({ data: 'aa', rawLength: 2, source: source(first) })
    )
    harness.completions[0]!.resolve()
    await firstAdmission

    const frameReady = harness.intake.waitForOwnershipTransferModelCheckpoints([first, second])
    const ready = vi.fn()
    void frameReady.then(ready)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()

    const secondAdmission = harness.intake.acceptData(
      event({ data: 'bb', rawLength: 2, source: source(second) })
    )
    harness.completions[1]!.resolve()
    await secondAdmission
    await expect(frameReady).resolves.toBeUndefined()
  })

  it('rejects the current delivery attempt after model failure and permits an exact retry', async () => {
    let attempts = 0
    const harness = createHarness(
      {
        acceptModel: () => {
          if (attempts++ === 0) {
            throw new Error('model unavailable')
          }
          return { sequence: 4, completion: Promise.resolve() }
        }
      },
      { ownershipTransferOutputEnabled: true }
    )
    const firstFrameAttempt = harness.intake.waitForOwnershipTransferModelCheckpoints([range()])
    await expect(harness.intake.acceptData(event({ source: source() }))).rejects.toThrow(
      'model unavailable'
    )
    await expect(firstFrameAttempt).rejects.toThrow('model unavailable')

    const retryAdmission = harness.intake.acceptData(event({ source: source() }))
    const retryFrameAttempt = harness.intake.waitForOwnershipTransferModelCheckpoints([range()])
    await expect(retryAdmission).resolves.toMatchObject({ sequence: 4 })
    await expect(retryFrameAttempt).resolves.toBeUndefined()
  })

  it('fails closed before model mutation when the durable checkpoint seam is absent', async () => {
    const acceptModel = vi.fn(() => ({ sequence: 4, completion: Promise.resolve() }))
    const harness = createHarness(
      { acceptModel, checkpointOwnershipTransferModel: undefined },
      { ownershipTransferOutputEnabled: true }
    )
    const frameReady = harness.intake.waitForOwnershipTransferModelCheckpoints([range()])

    await expect(harness.intake.acceptData(event({ source: source() }))).rejects.toThrow(
      'ssh_ownership_transfer_model_checkpoint_unavailable'
    )
    await expect(frameReady).rejects.toThrow('ssh_ownership_transfer_model_checkpoint_unavailable')
    expect(acceptModel).not.toHaveBeenCalled()
  })

  it('rejects a frame waiting on a generation that closes before admission', async () => {
    const harness = createHarness({}, { ownershipTransferOutputEnabled: true })
    const frameReady = harness.intake.waitForOwnershipTransferModelCheckpoints([range()])

    harness.intake.closeGeneration(1, 'provider_reconnected')
    await expect(frameReady).rejects.toThrow('provider_reconnected')
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
