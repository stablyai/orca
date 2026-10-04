import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import { defineMethod } from '../core'
import {
  Click,
  ComputerObserveTarget,
  ComputerPermissions,
  Drag,
  Hotkey,
  ListApps,
  ListWindows,
  PasteText,
  PerformSecondaryAction,
  PressKey,
  Scroll,
  SetValue,
  TypeText
} from './computer-schemas'
import {
  ComputerCapabilitiesParams,
  ComputerPermissionsStatusParams
} from '../../../../shared/rpc-contract/computer-params'

export function resetComputerSessionsForTest(): void {
  resetComputerSidecarForTest()
}

export const COMPUTER_METHODS = [
  defineMethod({
    name: 'computer.capabilities',
    params: ComputerCapabilitiesParams,
    handler: async () => {
      const capabilities = await callComputerSidecarCapabilities()
      return capabilities.guardedActions
        ? {
            ...capabilities,
            guardedActions: { ...capabilities.guardedActions, rpcVersion: 1 as const }
          }
        : capabilities
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    params: ListApps,
    handler: async () => {
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    params: ComputerPermissions,
    handler: async (params) => {
      const { openComputerUsePermissions } =
        await import('../../../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(params.id)
    }
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    params: ComputerPermissionsStatusParams,
    handler: async () => {
      const { getComputerUsePermissionStatus } =
        await import('../../../computer/macos-computer-use-permissions')
      return getComputerUsePermissionStatus()
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    params: ListWindows,
    handler: async (params) => {
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    params: ComputerObserveTarget,
    handler: async (params) => {
      return await callComputerSidecarSnapshot(params)
    }
  }),
  defineMethod({
    name: 'computer.click',
    params: Click,
    handler: async (params) => {
      await ensureComputerGuardSupported('click', params.ifSnapshotId)
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    params: PerformSecondaryAction,
    handler: async (params) => {
      await ensureComputerGuardSupported('performSecondaryAction', params.ifSnapshotId)
      return await callComputerSidecarAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    params: Scroll,
    handler: async (params) => {
      return await callComputerSidecarAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    params: Drag,
    handler: async (params) => {
      return await callComputerSidecarAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    params: TypeText,
    handler: async (params) => {
      return await callComputerSidecarAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    params: PressKey,
    handler: async (params) => {
      return await callComputerSidecarAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    params: Hotkey,
    handler: async (params) => {
      return await callComputerSidecarAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    params: PasteText,
    handler: async (params) => {
      return await callComputerSidecarAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    params: SetValue,
    handler: async (params) => {
      await ensureComputerGuardSupported('setValue', params.ifSnapshotId)
      return await callComputerSidecarAction('setValue', params)
    }
  })
]

async function ensureComputerGuardSupported(
  method: string,
  ifSnapshotId: string | undefined
): Promise<void> {
  if (ifSnapshotId === undefined) {
    return
  }
  const capabilities = await callComputerSidecarCapabilities()
  const guards = capabilities.guardedActions
  if (guards?.version !== 1 || !guards.actions.some((action) => action === method)) {
    throw new RuntimeClientError(
      'unsupported_capability',
      'This provider does not support guarded actions'
    )
  }
}
import { RuntimeClientError } from '../../../computer/runtime-client-error'
