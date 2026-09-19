import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareRequest
} from '../../shared/pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
  type PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { PtyDataEvent } from './pty-provider-events'
import { RuntimePtyOwnershipTransferReadOnlySource } from './runtime-pty-ownership-transfer-read-only-source'

const terminalId = 'local-pty-1'
const incarnationId = 'incarnation-1'
const destinationRuntimeId = 'runtime-destination'
const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:workspace-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: terminalId
}
const grantRequest: PtyOwnershipTransferSourceGrantRequest = {
  version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
  terminalId,
  destinationRuntimeId,
  surfaceBinding
}
const binding = {
  clientId: 17,
  transportGeneration: 7,
  pairedDeviceId: 'paired-device-1',
  isStale: () => false
} as const

let stateDirectory: string

beforeEach(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'orca-runtime-pty-source-grant-'))
})

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true })
})

function provider(currentIncarnationId = incarnationId) {
  const dataListeners = new Set<(event: PtyDataEvent) => void>()
  const exitListeners = new Set<(event: { id: string; code: number }) => void>()
  return {
    listProcesses: vi.fn(async () => [
      { id: terminalId, incarnationId: currentIncarnationId, cwd: '/workspace', title: 'shell' }
    ]),
    setInputFenced: vi.fn(),
    writeOwnershipTransferInput: vi.fn(() => true),
    resize: vi.fn(),
    sendSignal: vi.fn(async () => {}),
    clearBuffer: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 40 })),
    onData: (listener: (event: PtyDataEvent) => void) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onExit: (listener: (event: { id: string; code: number }) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    }
  }
}

async function enabledSource(options: Readonly<{ grantTtlMs?: number; now?: () => number }> = {}) {
  let source!: RuntimePtyOwnershipTransferReadOnlySource
  source = new RuntimePtyOwnershipTransferReadOnlySource({
    stateDirectory,
    runtimeId: 'runtime-source',
    mutationEnabled: () => true,
    authorizeMutationRequest: (method, request, requestBinding) =>
      source.authorizeMutationRequest(method, request, requestBinding),
    ...options
  })
  await source.reconcileProvider(provider())
  return source
}

function prepareRequest(
  source: RuntimePtyOwnershipTransferReadOnlySource
): PtyOwnershipTransferPrepareRequest {
  const grant = source.issueOwnershipTransferSourceGrant(grantRequest, binding)
  return {
    ...grant.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    surfacePublication: { version: 1, surfaceBinding: grant.surfaceBinding }
  }
}

describe('runtime PTY ownership-transfer source grants', () => {
  it('keeps grant issuance disabled with the default mutation canary', async () => {
    const source = new RuntimePtyOwnershipTransferReadOnlySource({ stateDirectory })
    await source.reconcileProvider(provider())

    expect(source.getOwnershipBridgeCapabilities().liveTransfer).toBe(false)
    expect(() => source.issueOwnershipTransferSourceGrant(grantRequest, binding)).toThrow()
  })

  it('mints a grant from current host authority and authorizes its exact binding', async () => {
    const source = await enabledSource()
    const authority = source.getOwnershipTransferSourceIdentity(terminalId)
    const grant = source.issueOwnershipTransferSourceGrant(grantRequest, binding)
    const request = {
      ...grant.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      surfacePublication: { version: 1 as const, surfaceBinding: grant.surfaceBinding }
    }

    expect(grant).toEqual({
      version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
      identity: {
        bridgeId: expect.stringMatching(/^runtime-/),
        terminalId,
        incarnationId: authority?.incarnationId,
        ownerLease: authority?.ownerLease,
        sourceOwnerGeneration: authority?.sourceOwnerGeneration,
        destinationRuntimeId
      },
      surfaceBinding
    })
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, binding)
    ).toBe(true)
  })

  it('rejects a grant replayed by another device or socket generation', async () => {
    const source = await enabledSource()
    const request = prepareRequest(source)

    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, {
        ...binding,
        pairedDeviceId: 'paired-device-2'
      })
    ).toBe(false)
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, {
        ...binding,
        transportGeneration: binding.transportGeneration + 1
      })
    ).toBe(false)
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, {
        ...binding,
        transportGeneration: 0
      })
    ).toBe(false)
  })

  it('rejects a grant used for a different published surface', async () => {
    const source = await enabledSource()
    const request = prepareRequest(source)

    expect(
      source.authorizeMutationRequest(
        PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
        {
          ...request,
          surfacePublication: {
            version: 1,
            surfaceBinding: { ...surfaceBinding, tabId: 'tab-2' }
          }
        },
        binding
      )
    ).toBe(false)
    expect(
      source.authorizeMutationRequest(
        PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
        { ...request, surfacePublication: undefined },
        binding
      )
    ).toBe(false)
  })

  it.each([
    ['terminal incarnation', { incarnationId: 'incarnation-stale' }],
    ['owner lease', { ownerLease: 'lease-stale' }],
    ['source generation', { sourceOwnerGeneration: 999 }]
  ] as const)('rejects a stale %s', async (_label, staleIdentity) => {
    const source = await enabledSource()
    const request = prepareRequest(source)

    expect(
      source.authorizeMutationRequest(
        PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
        { ...request, ...staleIdentity },
        binding
      )
    ).toBe(false)
  })

  it('invalidates a grant when the provider reports a replacement incarnation', async () => {
    const source = await enabledSource()
    const request = prepareRequest(source)

    await source.reconcileProvider(provider('incarnation-2'))

    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, binding)
    ).toBe(false)
    expect(source.getOwnershipTransferSourceIdentity(terminalId)).toMatchObject({
      incarnationId: 'incarnation-2',
      sourceOwnerGeneration: 2
    })
  })

  it('invalidates a grant at its exact expiry boundary', async () => {
    let now = 1_000
    const source = await enabledSource({ grantTtlMs: 50, now: () => now })
    const request = prepareRequest(source)

    now += 49
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, binding)
    ).toBe(true)

    now += 1
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, binding)
    ).toBe(false)
  })

  it('rejects self-targeted, stale-socket, and unknown-source grants', async () => {
    const source = await enabledSource()
    const request = prepareRequest(source)

    expect(() =>
      source.issueOwnershipTransferSourceGrant(
        { ...grantRequest, destinationRuntimeId: 'runtime-source' },
        binding
      )
    ).toThrow('pty_ownership_transfer_runtime_self_target')

    expect(
      source.authorizeMutationRequest(
        PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
        { ...request, destinationRuntimeId: 'runtime-source' },
        binding
      )
    ).toBe(false)
    expect(
      source.authorizeMutationRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, {
        ...binding,
        isStale: () => true
      })
    ).toBe(false)
    expect(() =>
      source.issueOwnershipTransferSourceGrant(
        { ...grantRequest, terminalId: 'unknown-local-pty' },
        binding
      )
    ).toThrow('pty_ownership_transfer_source_authority_unavailable')
  })
})
