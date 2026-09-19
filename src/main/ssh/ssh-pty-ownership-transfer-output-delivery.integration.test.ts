import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type { PtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferPrepareResult } from '../../shared/pty-ownership-transfer-wire'
import { createStore, testState } from '../persistence-test-harness'
import {
  acceptSshPtyOutputData,
  installSshPtyOutputIntake,
  settleSshPtyOwnershipTransferOutput,
  waitForSshPtyOwnershipTransferModelCheckpoints
} from '../ipc/ssh-pty-output-intake-registry'
import { SshPtyOutputIntake } from '../ipc/ssh-pty-output-intake'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import { SshPtyProviderOutputState } from '../providers/ssh-pty-provider-output-state'
import { SshPtyOwnershipTransferOutputDelivery } from './ssh-pty-ownership-transfer-output-delivery'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const appPtyId = 'ssh:conn@@pty-1'
const identity = {
  bridgeId: 'bridge-integration',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
} as const
const surfaceBinding = {
  executionHostId: 'ssh:conn',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: appPtyId
} as const
const prepareResult: PtyOwnershipTransferPrepareResult = {
  ...identity,
  version: 1,
  phase: 'prepared',
  sourceOutputEndSeq: 1,
  replayStartSeq: 1,
  surfacePublication: { version: 1, surfaceBinding }
}
const commitReceipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'commit-integration',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 1,
  committedAt: '2026-08-31T12:00:00.000Z'
}

let cleanupIntake: (() => void) | undefined
let outputState: SshPtyProviderOutputState | undefined

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-output-integration-'))
})

afterEach(() => {
  outputState?.dispose()
  outputState = undefined
  cleanupIntake?.()
  cleanupIntake = undefined
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('SSH ownership-transfer output delivery integration', () => {
  it('withholds source credit until replay, model, attachment, and output ACK converge', async () => {
    const destinationAcks: number[] = []
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn(),
      publishPostCommitOutputAcknowledged: (ackIdentity, _binding, frame) => {
        destinationAcks.push(frame.seq)
        return { identity: ackIdentity, throughSeq: frame.seq }
      }
    })
    const destination = preparePublishedDestination(registry)
    const reservation = destination.reserveExecutionAttachment('attachment-1')
    const model = deferred()
    const checkpoint = deferred()
    const checkpointModel = vi.fn(() => checkpoint.promise)
    const sourceAck = deferred<Readonly<{ creditedEndSu: number }>>()
    let modelSequence = 0
    const intake = new SshPtyOutputIntake(
      {
        getModelSequence: () => modelSequence,
        acceptModel: (event) => {
          modelSequence += event.rawLength
          return { sequence: modelSequence, completion: model.promise }
        },
        checkpointOwnershipTransferModel: checkpointModel,
        project: vi.fn(),
        prepareExit: vi.fn(),
        finalizeExit: vi.fn(),
        publishSourceAck: (_generation, batch, onSettled) => {
          const acknowledgement = batch.acknowledgements[0]
          if (acknowledgement) {
            sourceAck.resolve(acknowledgement)
          }
          onSettled({ ok: true })
        }
      },
      { ownershipTransferOutputEnabled: true }
    )
    cleanupIntake = installSshPtyOutputIntake(intake)
    const delivery = new SshPtyOwnershipTransferOutputDelivery({
      destination: registry,
      waitForModelCheckpoints: waitForSshPtyOwnershipTransferModelCheckpoints,
      settleSourceRange: settleSshPtyOwnershipTransferOutput
    })
    const notification = installOutputState(delivery)
    let dataReceipt: ReturnType<typeof acceptSshPtyOutputData> | undefined
    outputState!.onData((payload) => {
      dataReceipt = acceptSshPtyOutputData({
        ...payload,
        rawLength: payload.sequenceChars ?? payload.data.length,
        transformed: payload.transformed === true
      })
    })
    outputState!.installReceivingActivation('pty-1', sourceActivation()).commit()

    notification('pty.data', transferNotification())
    expect(registry.pendingPostCommitOutput(identity)?.pendingFrames).toEqual([
      { seq: 3, data: 'live' }
    ])
    expect(destinationAcks).toEqual([])

    model.resolve()
    await vi.waitFor(() => expect(checkpointModel).toHaveBeenCalledOnce())
    expect(destinationAcks).toEqual([])
    checkpoint.resolve()
    const receipt = await requireDataReceipt(dataReceipt)
    const projectionId = receipt.projection.identity.projectionSemanticsId
    intake.publishProjectionPrefix([projectionId], 4, 4)
    intake.settleProjectionPrefix(appPtyId, 4)
    await expect(Promise.race([sourceAck.promise, Promise.resolve('pending')])).resolves.toBe(
      'pending'
    )

    destination.acceptPostCommitReplayOutput({ seq: 2, data: 'replay' }, reservation)
    registry.acceptDestinationAttachment(
      {
        ...identity,
        version: 1,
        phase: 'published',
        attachmentId: 'attachment-1',
        executionVerdict: 'live'
      },
      reservation
    )

    await expect(sourceAck.promise).resolves.toMatchObject({ creditedEndSu: 4 })
    expect(destinationAcks).toEqual([2, 3])
    expect(destination.snapshot()).toMatchObject({
      attachmentId: 'attachment-1',
      executionVerdict: 'live',
      liveOutputEndSeq: 3
    })
  })
})

function preparePublishedDestination(registry: PtyOwnershipTransferDestinationRuntimeRegistry) {
  const prepared = registry.prepare(prepareResult)
  prepared.adapter.bindSurface(surfaceBinding)
  prepared.adapter.acceptReplay({
    ...prepareResult,
    frames: [{ seq: 1, data: 'baseline' }]
  })
  prepared.adapter.commit(commitReceipt)
  prepared.adapter.publish()
  return prepared.adapter
}

function installOutputState(delivery: SshPtyOwnershipTransferOutputDelivery) {
  let notification: ((method: string, params: Record<string, unknown>) => void) | undefined
  const mux = {
    onNotification: (callback: typeof notification) => {
      notification = callback
      return vi.fn()
    },
    request: vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
  }
  outputState = new SshPtyProviderOutputState(7, {
    mux: mux as never,
    toAppPtyId: () => appPtyId,
    livePtyIds: new Set(),
    recordExit: vi.fn(),
    onOwnershipTransferOutput: delivery.accept
  })
  if (!notification) {
    throw new Error('SSH PTY notification listener was not installed')
  }
  return notification
}

function sourceActivation(): PtySourceReceivingActivation {
  return {
    status: 'pending',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: identity.incarnationId,
    deliveryToken: 'token-1',
    checkpointSourceEndSu: 0,
    recoveryEndSu: 0
  }
}

function transferNotification(): Record<string, unknown> {
  return {
    id: identity.terminalId,
    data: 'live',
    ptyIncarnation: identity.incarnationId,
    deliveryToken: 'token-1',
    clientGeneration: 2,
    ownerGeneration: 3,
    sourceEndSu: 4,
    sourceLengthSu: 4,
    ownershipTransfer: {
      ...identity,
      version: 1,
      frameSeq: 3,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4
    }
  }
}

function requireDataReceipt(receipt: ReturnType<typeof acceptSshPtyOutputData> | undefined) {
  if (!receipt) {
    throw new Error('SSH PTY notification did not reach the output intake')
  }
  return receipt
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
