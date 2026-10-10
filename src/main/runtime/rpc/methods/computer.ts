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
} from '../../../../shared/rpc-contract/computer-schemas-params'
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
    permission: 'workspace',
    params: ComputerCapabilitiesParams,
    handler: async () => {
      return await callComputerSidecarCapabilities()
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    permission: 'desktop-control',
    params: ListApps,
    handler: async () => {
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    permission: 'desktop-control',
    params: ComputerPermissions,
    handler: async (params) => {
      const { openComputerUsePermissions } =
        await import('../../../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(params.id)
    }
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    permission: 'workspace',
    params: ComputerPermissionsStatusParams,
    handler: async () => {
      const { getComputerUsePermissionStatus } =
        await import('../../../computer/macos-computer-use-permissions')
      return getComputerUsePermissionStatus()
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    permission: 'desktop-control',
    params: ListWindows,
    handler: async (params) => {
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    permission: 'desktop-control',
    params: ComputerObserveTarget,
    handler: async (params) => {
      return await callComputerSidecarSnapshot(params)
    }
  }),
  defineMethod({
    name: 'computer.click',
    permission: 'desktop-control',
    params: Click,
    handler: async (params) => {
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    permission: 'desktop-control',
    params: PerformSecondaryAction,
    handler: async (params) => {
      return await callComputerSidecarAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    permission: 'desktop-control',
    params: Scroll,
    handler: async (params) => {
      return await callComputerSidecarAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    permission: 'desktop-control',
    params: Drag,
    handler: async (params) => {
      return await callComputerSidecarAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    permission: 'desktop-control',
    params: TypeText,
    handler: async (params) => {
      return await callComputerSidecarAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    permission: 'desktop-control',
    params: PressKey,
    handler: async (params) => {
      return await callComputerSidecarAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    permission: 'desktop-control',
    params: Hotkey,
    handler: async (params) => {
      return await callComputerSidecarAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    permission: 'desktop-control',
    params: PasteText,
    handler: async (params) => {
      return await callComputerSidecarAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    permission: 'desktop-control',
    params: SetValue,
    handler: async (params) => {
      return await callComputerSidecarAction('setValue', params)
    }
  })
]
