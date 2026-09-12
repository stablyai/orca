import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const environmentId = 'environment-source'
const terminalId = 'terminal-source'
const incarnationId = 'incarnation-source'
const ptyId = toRemoteRuntimePtyId(terminalId, environmentId)
const workspaceKey = folderWorkspaceKey('folder-1')
const tabId = 'tab-1'
const leafId = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-paired-transfer-coordinator-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('OrcaRuntimeService paired ownership-transfer coordinator composition', () => {
  it('requires the release gate and both paired transports', () => {
    const closed = createRuntime({ mutationEnabled: () => false })
    expect(
      closed.runtime.createPairedRuntimePtyOwnershipTransferCoordinator(closed.options)
    ).toBeNull()

    const unaryOnly = createRuntime({ mutationEnabled: () => true, subscribe: null })
    expect(
      unaryOnly.runtime.createPairedRuntimePtyOwnershipTransferCoordinator(unaryOnly.options)
    ).toBeNull()
    expect(unaryOnly.call).not.toHaveBeenCalled()
  })

  it('constructs only for the exact tracked remote surface and source environment', () => {
    const fixture = createRuntime({ mutationEnabled: () => true })

    expect(
      fixture.runtime.createPairedRuntimePtyOwnershipTransferCoordinator(fixture.options)
    ).toMatchObject({ transfer: expect.any(Function), recover: expect.any(Function) })
    expect(
      fixture.runtime.createPairedRuntimePtyOwnershipTransferCoordinator({
        ...fixture.options,
        environmentId: 'environment-other'
      })
    ).toBeNull()
    expect(
      fixture.runtime.createPairedRuntimePtyOwnershipTransferCoordinator({
        ...fixture.options,
        identity: { ...fixture.options.identity, incarnationId: 'incarnation-other' }
      })
    ).toBeNull()
    expect(fixture.call).not.toHaveBeenCalled()
  })

  it('rechecks the gate before contacting or fencing the paired source', async () => {
    let enabled = true
    const fixture = createRuntime({ mutationEnabled: () => enabled })
    const coordinator = fixture.runtime.createPairedRuntimePtyOwnershipTransferCoordinator(
      fixture.options
    )
    expect(coordinator).not.toBeNull()

    enabled = false
    await expect(coordinator!.transfer()).rejects.toThrow(
      'pty_ownership_transfer_production_transfer_disabled'
    )
    expect(fixture.call).not.toHaveBeenCalled()
    expect(fixture.subscribe).not.toHaveBeenCalled()
  })
})

function createRuntime(args: {
  mutationEnabled: () => boolean
  subscribe?: ReturnType<typeof vi.fn> | null
}) {
  const call = vi.fn()
  const subscribe = args.subscribe === undefined ? vi.fn() : args.subscribe
  const runtime = new OrcaRuntimeService(createStore(), undefined, {
    ptyOwnershipTransferMutationEnabled: args.mutationEnabled,
    callPairedRuntimePtyOwnershipTransferRpc: call,
    ...(subscribe ? { subscribePairedRuntimePtyOwnershipTransfer: subscribe as never } : {}),
    publishPtyOwnershipTransferPostCommitOutput: vi.fn(),
    publishPtyOwnershipTransferPostCommitOutputAcknowledged: (identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    })
  })
  runtime.registerPty(ptyId, workspaceKey, null, { tabId, leafId, incarnationId })
  const options = {
    environmentId,
    identity: {
      bridgeId: 'bridge-1',
      terminalId,
      incarnationId,
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 1,
      destinationRuntimeId: runtime.getRuntimeId()
    },
    surfaceBinding: {
      executionHostId: toRuntimeExecutionHostId(environmentId),
      workspaceKey,
      tabId,
      leafId,
      ptyId
    }
  }
  return { call, options, runtime, subscribe }
}
