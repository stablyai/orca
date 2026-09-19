import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import type { RelayPtyOwnershipTransferSource } from '../../relay/relay-pty-ownership-transfer-adapter'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferOutputAcknowledgementRequest
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { RuntimePtyOwnershipTransferSourceAdapter } from './runtime-pty-ownership-transfer-source-adapter'

const source = {
  terminalId: 'pty-local-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 2
} as const

const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: source.terminalId
}

const identity = {
  bridgeId: 'bridge-1',
  ...source,
  destinationRuntimeId: 'runtime-destination'
} as const

const currentBinding = {
  clientId: 7,
  transportGeneration: 3,
  isStale: () => false
} as const

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-pty-transfer-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function prepareRequest(): PtyOwnershipTransferPrepareRequest {
  return {
    ...identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    surfacePublication: { version: 1, surfaceBinding }
  }
}

function acknowledgeRequest(
  attachmentId = 'attachment-1'
): PtyOwnershipTransferOutputAcknowledgementRequest {
  return {
    ...identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId,
    throughSeq: 1
  }
}

function attachCommitted(adapter: RuntimePtyOwnershipTransferSourceAdapter): void {
  adapter.prepare(prepareRequest(), currentBinding)
  adapter.commit(
    {
      ...identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      acceptedSourceEndSeq: 0,
      receipt: {
        receiptId: 'receipt-ack',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 0,
        committedAt: '2026-08-31T00:00:00.000Z'
      }
    },
    currentBinding
  )
  adapter.attachDestination(
    {
      ...identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      attachmentId: 'attachment-1'
    },
    currentBinding
  )
}

function createAdapter(
  overrides: {
    mutationEnabled?: () => boolean
    resolveSource?: (terminalId: string) => RelayPtyOwnershipTransferSource | null
    setInputFenced?: (terminalId: string, fenced: boolean) => void
    published?: { seq: number; data: string }[]
    inputs?: string[]
    exits?: unknown[]
    authorizeMutationRequest?: (method: string) => boolean
  } = {}
) {
  return new RuntimePtyOwnershipTransferSourceAdapter({
    replayBytes: 1024,
    inputIds: 32,
    mutationEnabled: overrides.mutationEnabled ?? (() => true),
    authorizeMutationRequest: overrides.authorizeMutationRequest ?? (() => true),
    store: new RelayPtyOwnershipTransferFileStore(directory),
    resolveSource:
      overrides.resolveSource ??
      ((terminalId) => (terminalId === source.terminalId ? source : null)),
    setInputFenced: overrides.setInputFenced ?? vi.fn(),
    writeDestinationInput: (_terminalId, data) => overrides.inputs?.push(data),
    publishDestinationOutput: (_wireIdentity, _attachmentId, frame) =>
      overrides.published?.push(frame),
    applyDestinationControl: async () => 'applied' as const,
    publishDestinationExit: (event) => overrides.exits?.push(event)
  })
}

describe('RuntimePtyOwnershipTransferSourceAdapter', () => {
  it('keeps complete routes dormant without an explicit mutation gate', () => {
    const adapter = new RuntimePtyOwnershipTransferSourceAdapter({
      store: new RelayPtyOwnershipTransferFileStore(directory),
      resolveSource: () => source,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn(),
      applyDestinationControl: vi.fn(async () => 'applied' as const),
      publishDestinationExit: vi.fn()
    })

    expect(adapter.getCapabilities()).toMatchObject({
      liveTransfer: false,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true,
      statusQuery: true
    })
    expect(() => adapter.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_source_unavailable'
    )
  })

  it('keeps mutation fail-closed until output, control, and exit routes all exist', () => {
    const partial = new RuntimePtyOwnershipTransferSourceAdapter({
      resolveSource: () => source,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn()
    })

    expect(partial.getCapabilities()).toMatchObject({
      liveTransfer: false,
      destinationOutput: true,
      statusQuery: true
    })
    expect(partial.getCapabilities()).not.toHaveProperty('destinationControl')
    expect(partial.getCapabilities()).not.toHaveProperty('authoritativeExit')
    expect(() => partial.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_source_unavailable'
    )
  })

  it('keeps runtime mutation disabled by default even when every route exists', () => {
    const dormant = new RuntimePtyOwnershipTransferSourceAdapter({
      store: new RelayPtyOwnershipTransferFileStore(directory),
      resolveSource: () => source,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn(),
      applyDestinationControl: async () => 'applied' as const,
      publishDestinationExit: vi.fn()
    })

    expect(dormant.getCapabilities()).toMatchObject({
      liveTransfer: false,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true,
      statusQuery: true
    })
    expect(() => dormant.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_source_unavailable'
    )
  })

  it('requires an explicit owner authorization seam before advertising mutation', () => {
    const adapter = new RuntimePtyOwnershipTransferSourceAdapter({
      mutationEnabled: () => true,
      store: new RelayPtyOwnershipTransferFileStore(directory),
      resolveSource: () => source,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn(),
      applyDestinationControl: async () => 'applied' as const,
      publishDestinationExit: vi.fn()
    })

    expect(adapter.getCapabilities().liveTransfer).toBe(false)
    expect(() => adapter.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_source_unavailable'
    )
  })

  it('rejects an unauthorized owner before the source input fence mutates', () => {
    const authorizeMutationRequest = vi.fn(() => false)
    const setInputFenced = vi.fn()
    const adapter = createAdapter({ authorizeMutationRequest, setInputFenced })

    expect(() => adapter.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_request_unauthorized'
    )
    expect(authorizeMutationRequest).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
      prepareRequest(),
      currentBinding
    )
    expect(setInputFenced).not.toHaveBeenCalled()
  })

  it('rechecks the transport generation after owner authorization', () => {
    let stale = false
    const authorizeMutationRequest = vi.fn(() => {
      stale = true
      return true
    })
    const setInputFenced = vi.fn()
    const adapter = createAdapter({ authorizeMutationRequest, setInputFenced })
    const binding = { ...currentBinding, isStale: () => stale }

    expect(() => adapter.prepare(prepareRequest(), binding)).toThrow(
      'pty_ownership_transfer_runtime_request_stale'
    )
    expect(authorizeMutationRequest).toHaveBeenCalledOnce()
    expect(setInputFenced).not.toHaveBeenCalled()
  })

  it('authorizes the attachment-scoped source stream through the same gate', () => {
    const authorizeMutationRequest = vi.fn(() => true)
    const adapter = createAdapter({ authorizeMutationRequest })
    const request = { ...prepareRequest(), attachmentId: 'attachment-1' }

    expect(() => adapter.assertStreamAuthorized(request, currentBinding)).not.toThrow()
    expect(authorizeMutationRequest).toHaveBeenCalledWith(
      'pty.ownershipTransfer.streamSource',
      request,
      currentBinding
    )
  })

  it('requires a durable journal before a mutation gate can advertise live transfer', () => {
    const memoryOnly = new RuntimePtyOwnershipTransferSourceAdapter({
      mutationEnabled: () => true,
      authorizeMutationRequest: () => true,
      resolveSource: () => source,
      setInputFenced: vi.fn(),
      writeDestinationInput: vi.fn(),
      publishDestinationOutput: vi.fn(),
      applyDestinationControl: async () => 'applied' as const,
      publishDestinationExit: vi.fn()
    })

    expect(memoryOnly.getCapabilities()).toMatchObject({
      liveTransfer: false,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true
    })
    expect(memoryOnly.getCapabilities()).not.toHaveProperty('postCommitReplay')
    expect(memoryOnly.getCapabilities()).not.toHaveProperty('reconnectRekey')
    expect(() => memoryOnly.prepare(prepareRequest(), currentBinding)).toThrow(
      'pty_ownership_transfer_runtime_source_unavailable'
    )
  })

  it('captures replay durably and restores the exact fenced transfer after restart', () => {
    const fences: boolean[] = []
    const first = createAdapter({
      setInputFenced: (_terminalId, fenced) => fences.push(fenced)
    })
    expect(first.getCapabilities()).toMatchObject({
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true,
      maxReplayBytes: 1024,
      maxInputIds: 32
    })
    first.observeOutput({ ...source, data: 'before' })
    expect(first.prepare(prepareRequest(), currentBinding)).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1
    })
    first.observeOutput({ ...source, data: 'during' })

    const restoredFences: boolean[] = []
    const restored = createAdapter({
      setInputFenced: (_terminalId, fenced) => restoredFences.push(fenced)
    })
    expect(restored.snapshot(identity.bridgeId)).toMatchObject({
      phase: 'prepared',
      identity,
      sourceOutputEndSeq: 2,
      replayStartSeq: 1
    })
    expect(
      restored.replay(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          afterSeq: 0
        },
        currentBinding
      ).frames
    ).toEqual([
      { seq: 1, data: 'before' },
      { seq: 2, data: 'during' }
    ])
    expect(fences).toEqual([true])
    expect(restoredFences).toEqual([true])
  })

  it('re-applies a durable fence after provider liveness is reproven', () => {
    const first = createAdapter()
    first.prepare(prepareRequest(), currentBinding)

    let currentSource: RelayPtyOwnershipTransferSource | null = null
    const fences: boolean[] = []
    const restored = createAdapter({
      resolveSource: () => currentSource,
      setInputFenced: (_terminalId, fenced) => fences.push(fenced)
    })
    expect(fences).toEqual([])

    currentSource = { ...source, ownerLease: 'replacement-lease' }
    expect(restored.restoreInputFences()).toBe(0)
    expect(fences).toEqual([])

    currentSource = source
    expect(restored.restoreInputFences()).toBe(1)
    expect(fences).toEqual([true])
  })

  it('routes committed output, deduplicated input, controls, and host-positive exit', async () => {
    const published: { seq: number; data: string }[] = []
    const inputs: string[] = []
    const exits: unknown[] = []
    const adapter = createAdapter({ published, inputs, exits })
    adapter.prepare(prepareRequest(), currentBinding)
    adapter.commit(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        acceptedSourceEndSeq: 0,
        receipt: {
          receiptId: 'receipt-1',
          bridgeId: identity.bridgeId,
          acceptedSourceEndSeq: 0,
          committedAt: '2026-08-31T00:00:00.000Z'
        }
      },
      currentBinding
    )
    const binding = currentBinding
    adapter.attachDestination(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: 'attachment-1'
      },
      binding
    )

    adapter.observeOutput({ ...source, data: 'post-commit', emissionKey: 'emission-1' })
    expect(published).toEqual([{ seq: 1, data: 'post-commit' }])
    expect(
      adapter.acceptInput(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          inputId: 'input-1',
          data: 'pwd\n'
        },
        binding
      )
    ).toEqual({ accepted: true, duplicate: false })
    expect(
      adapter.acceptInput(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          inputId: 'input-1',
          data: 'pwd\n'
        },
        binding
      )
    ).toEqual({ accepted: false, duplicate: true })
    expect(inputs).toEqual(['pwd\n'])
    await expect(
      adapter.controlDestination(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          attachmentId: 'attachment-1',
          controlId: 'control-1',
          control: { kind: 'resize', cols: 100, rows: 40 }
        },
        binding
      )
    ).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
    adapter.observeExit({
      terminalId: source.terminalId,
      incarnationId: source.incarnationId,
      code: 0
    })
    expect(exits).toEqual([
      expect.objectContaining({
        bridgeId: identity.bridgeId,
        attachmentId: 'attachment-1',
        exit: expect.objectContaining({ verdict: 'exited', code: 0 })
      })
    ])
  })

  it('routes a cumulative output acknowledgement to the matching live stream binding', () => {
    const adapter = createAdapter()
    attachCommitted(adapter)
    const acknowledge = vi.fn()
    const dispose = adapter.onDestinationOutputAcknowledgement(
      identity,
      'attachment-1',
      currentBinding,
      acknowledge
    )

    expect(adapter.acknowledgeDestinationOutput(acknowledgeRequest(), currentBinding)).toEqual({
      version: 1,
      identity,
      attachmentId: 'attachment-1',
      throughSeq: 1
    })
    expect(acknowledge).toHaveBeenCalledWith(1)
    dispose()
  })

  it('allows the output ACK stream to register before the destination attach barrier', () => {
    const adapter = createAdapter()
    adapter.prepare(prepareRequest(), currentBinding)

    adapter.onDestinationOutputAcknowledgement(identity, 'attachment-1', currentBinding, vi.fn())
    expect(() =>
      adapter.acknowledgeDestinationOutput(acknowledgeRequest(), currentBinding)
    ).toThrow('pty_ownership_transfer_output_credit_attachment_unavailable')
  })

  it('rejects output acknowledgements from stale bindings or missing streams', () => {
    const adapter = createAdapter()
    attachCommitted(adapter)
    const dispose = adapter.onDestinationOutputAcknowledgement(
      identity,
      'attachment-1',
      currentBinding,
      vi.fn()
    )

    expect(() =>
      adapter.acknowledgeDestinationOutput(acknowledgeRequest(), {
        clientId: currentBinding.clientId + 1,
        transportGeneration: currentBinding.transportGeneration,
        isStale: () => false
      })
    ).toThrow('pty_ownership_transfer_output_credit_ack_stale_binding')
    dispose()
    expect(() =>
      adapter.acknowledgeDestinationOutput(acknowledgeRequest(), currentBinding)
    ).toThrow('pty_ownership_transfer_output_credit_ack_unregistered')
  })

  it('applies the mutation authorization gate before routing output acknowledgements', () => {
    const authorizeMutationRequest = vi.fn(
      (method: string) => method !== PTY_OWNERSHIP_TRANSFER_METHODS.acknowledgeOutput
    )
    const adapter = createAdapter({ authorizeMutationRequest })
    attachCommitted(adapter)
    adapter.onDestinationOutputAcknowledgement(identity, 'attachment-1', currentBinding, vi.fn())

    expect(() =>
      adapter.acknowledgeDestinationOutput(acknowledgeRequest(), currentBinding)
    ).toThrow('pty_ownership_transfer_runtime_request_unauthorized')
    expect(authorizeMutationRequest).toHaveBeenCalledWith(
      PTY_OWNERSHIP_TRANSFER_METHODS.acknowledgeOutput,
      acknowledgeRequest(),
      currentBinding
    )
  })

  it('rekeys a resumed attachment and fences post-commit replay to its binding', () => {
    const adapter = createAdapter()
    adapter.prepare(prepareRequest(), currentBinding)
    adapter.commit(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        acceptedSourceEndSeq: 0,
        receipt: {
          receiptId: 'receipt-1',
          bridgeId: identity.bridgeId,
          acceptedSourceEndSeq: 0,
          committedAt: '2026-08-31T00:00:00.000Z'
        }
      },
      currentBinding
    )
    adapter.attachDestination(
      {
        ...identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: 'attachment-1'
      },
      currentBinding
    )
    adapter.observeOutput({ ...source, data: 'after-commit', emissionKey: 'emission-1' })

    expect(
      adapter.rekeyReconnect(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          previousReconnectGeneration: 2,
          reconnectGeneration: 3,
          attachmentId: 'attachment-2'
        },
        { clientId: 8, transportGeneration: 4, isStale: () => false }
      )
    ).toMatchObject({
      phase: 'committed',
      attachmentId: 'attachment-2',
      reconnectGeneration: 3,
      executionVerdict: 'live'
    })
    expect(
      adapter.replay(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          afterSeq: 0,
          attachmentId: 'attachment-2'
        },
        { clientId: 8, transportGeneration: 4, isStale: () => false }
      ).frames
    ).toEqual([{ seq: 1, data: 'after-commit' }])
    expect(() =>
      adapter.replay(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          afterSeq: 0,
          attachmentId: 'attachment-2'
        },
        currentBinding
      )
    ).toThrow('destination control does not match the attached relay client generation')
  })

  it('does not journal output after the same terminal ID changes incarnation', () => {
    let currentSource: RelayPtyOwnershipTransferSource | null = source
    const adapter = createAdapter({ resolveSource: () => currentSource })
    adapter.observeOutput({ ...source, data: 'before' })
    adapter.prepare(prepareRequest(), currentBinding)

    currentSource = { ...source, incarnationId: 'incarnation-replacement' }
    expect(
      adapter.observeOutput({
        terminalId: source.terminalId,
        incarnationId: 'incarnation-replacement',
        data: 'replacement-output'
      })
    ).toBeUndefined()
    adapter.observeExit({
      terminalId: source.terminalId,
      incarnationId: 'incarnation-replacement',
      code: 0
    })
    expect(adapter.snapshot(identity.bridgeId)).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1
    })
    expect(
      adapter.replay(
        {
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          afterSeq: 0
        },
        currentBinding
      ).frames
    ).toEqual([{ seq: 1, data: 'before' }])
  })
})
