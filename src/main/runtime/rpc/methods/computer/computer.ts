import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarLaunchApp,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot
} from '../../../../computer/sidecar-transport/sidecar-client'
import { assertTeamAllowsComputerUse } from '../../../../computer/computer-team-policy'
import { defineMethod } from '../../core'
import {
  Click,
  ComputerObserveTarget,
  ComputerPermissions,
  Drag,
  Hotkey,
  LaunchApp,
  ListApps,
  ListWindows,
  PasteText,
  PerformSecondaryAction,
  PressKey,
  Scroll,
  SetValue,
  TypeText
} from '../../../../../shared/rpc-contract/computer/computer-schemas-params'
import {
  ComputerCapabilitiesParams,
  ComputerPermissionsStatusParams
} from '../../../../../shared/rpc-contract/computer/computer-params'

export const COMPUTER_METHODS = [
  defineMethod({
    name: 'computer.capabilities',
    permission: 'workspace',
    share: 'not-shared',
    params: ComputerCapabilitiesParams,
    handler: async () => {
      return await callComputerSidecarCapabilities()
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    permission: 'desktop-control',
    share: 'not-shared',
    params: ListApps,
    handler: async () => {
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    permission: 'desktop-control',
    share: 'not-shared',
    params: ComputerPermissions,
    handler: async (params) => {
      assertTeamAllowsComputerUse()
      const { openComputerUsePermissions } =
        await import('../../../../computer/macos-permissions/macos-computer-use-permissions')
      return openComputerUsePermissions(params.id, { skipGranted: params.skipGranted === true })
    }
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    permission: 'workspace',
    share: 'not-shared',
    params: ComputerPermissionsStatusParams,
    handler: async () => {
      const { computerUsePermissionStatusGate } =
        await import('../../../../computer/macos-permissions/macos-computer-use-permission-status-gate')
      return computerUsePermissionStatusGate.read()
    }
  }),
  defineMethod({
    name: 'computer.launchApp',
    permission: 'desktop-control',
    share: 'not-shared',
    params: LaunchApp,
    handler: async (params) => {
      return await callComputerSidecarLaunchApp(params)
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    permission: 'desktop-control',
    share: 'not-shared',
    params: ListWindows,
    handler: async (params) => {
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    permission: 'desktop-control',
    share: 'not-shared',
    params: ComputerObserveTarget,
    handler: async (params) => {
      return await callComputerSidecarSnapshot(params)
    }
  }),
  defineMethod({
    name: 'computer.click',
    permission: 'desktop-control',
    share: 'not-shared',
    params: Click,
    handler: async (params) => {
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    permission: 'desktop-control',
    share: 'not-shared',
    params: PerformSecondaryAction,
    handler: async (params) => {
      return await callComputerSidecarAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    permission: 'desktop-control',
    share: 'not-shared',
    params: Scroll,
    handler: async (params) => {
      return await callComputerSidecarAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    permission: 'desktop-control',
    share: 'not-shared',
    params: Drag,
    handler: async (params) => {
      return await callComputerSidecarAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    permission: 'desktop-control',
    share: 'not-shared',
    params: TypeText,
    handler: async (params) => {
      return await callComputerSidecarAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    permission: 'desktop-control',
    share: 'not-shared',
    params: PressKey,
    handler: async (params) => {
      return await callComputerSidecarAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    permission: 'desktop-control',
    share: 'not-shared',
    params: Hotkey,
    handler: async (params) => {
      return await callComputerSidecarAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    permission: 'desktop-control',
    share: 'not-shared',
    params: PasteText,
    handler: async (params) => {
      return await callComputerSidecarAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    permission: 'desktop-control',
    share: 'not-shared',
    params: SetValue,
    handler: async (params) => {
      return await callComputerSidecarAction('setValue', params)
    }
  })
]
