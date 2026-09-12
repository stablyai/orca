import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import {
  validatePtyOwnershipTransferDestinationOutputRoute,
  type PtyOwnershipTransferDestinationOutputRoute
} from './pty-ownership-transfer-destination-output-admission'

const connectionId = 'ssh-target-1'
const leafId = '11111111-1111-4111-8111-111111111111'
const identity: PtyOwnershipTransferWireIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'relay-pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
}
const binding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: toSshExecutionHostId(connectionId),
  workspaceKey: 'worktree:repo-1::/workspace',
  tabId: 'tab-1',
  leafId,
  ptyId: toAppSshPtyId(connectionId, identity.terminalId)
}
type TrackedPty = Readonly<{
  incarnationId: string
  worktreeId: string
  connectionId: string | null
  tabId: string
  paneKey: string
}>

const tracked: TrackedPty = {
  incarnationId: identity.incarnationId,
  worktreeId: 'repo-1::/workspace',
  connectionId,
  tabId: binding.tabId,
  paneKey: makePaneKey(binding.tabId, binding.leafId)
}

function route(
  overrides: Partial<TrackedPty> = {}
): PtyOwnershipTransferDestinationOutputRoute {
  return {
    runtimeId: identity.destinationRuntimeId,
    inspectPty: () => ({ ...tracked, ...overrides })
  }
}

describe('validatePtyOwnershipTransferDestinationOutputRoute', () => {
  it('accepts an exact direct-SSH destination route', () => {
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(route(), identity, binding)
    ).not.toThrow()
  })

  it.each([
    ['incarnation', { incarnationId: 'stale-incarnation' }],
    ['connection', { connectionId: 'other-target' }],
    ['workspace', { worktreeId: 'other-worktree' }],
    ['tab', { tabId: 'other-tab' }],
    ['leaf', { paneKey: makePaneKey(binding.tabId, '22222222-2222-4222-8222-222222222222') }]
  ])('rejects a mismatched tracked %s', (_name, overrides) => {
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(route(overrides), identity, binding)
    ).toThrow('pty_ownership_transfer_destination_output_route_mismatch')
  })

  it('rejects a raw relay identity routed through another app PTY', () => {
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(route(), identity, {
        ...binding,
        ptyId: toAppSshPtyId(connectionId, 'other-relay-pty')
      })
    ).toThrow('pty_ownership_transfer_destination_output_route_mismatch')
  })

  it('supports an exact folder-workspace owner without treating it as a worktree', () => {
    const folderBinding = { ...binding, workspaceKey: 'folder:folder-1' as const }
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(
        route({ worktreeId: 'folder:folder-1' }),
        identity,
        folderBinding
      )
    ).not.toThrow()
  })

  it('accepts an exact paired-runtime destination route', () => {
    const environmentId = 'paired env/1'
    const pairedBinding: PtyOwnershipTransferSurfaceBinding = {
      ...binding,
      executionHostId: toRuntimeExecutionHostId(environmentId),
      ptyId: toRemoteRuntimePtyId(identity.terminalId, environmentId)
    }
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(
        route({ connectionId: null }),
        identity,
        pairedBinding
      )
    ).not.toThrow()
  })

  it('rejects a paired-runtime route whose encoded owner changed', () => {
    const pairedBinding: PtyOwnershipTransferSurfaceBinding = {
      ...binding,
      executionHostId: toRuntimeExecutionHostId('environment-1'),
      ptyId: toRemoteRuntimePtyId(identity.terminalId, 'environment-2')
    }
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(
        route({ connectionId: null }),
        identity,
        pairedBinding
      )
    ).toThrow('pty_ownership_transfer_surface_binding_invalid')
  })

  it('accepts an exact local-runtime destination route', () => {
    const localBinding: PtyOwnershipTransferSurfaceBinding = {
      ...binding,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      ptyId: identity.terminalId
    }
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(
        route({ connectionId: null }),
        identity,
        localBinding
      )
    ).not.toThrow()
  })

  it('rejects a foreign paired-runtime PTY without an encoded owner', () => {
    expect(() =>
      validatePtyOwnershipTransferDestinationOutputRoute(
        route({ connectionId: null }),
        identity,
        {
          ...binding,
          executionHostId: toRuntimeExecutionHostId('environment-1'),
          ptyId: toRemoteRuntimePtyId(identity.terminalId)
        }
      )
    ).toThrow('pty_ownership_transfer_surface_binding_invalid')
  })
})
