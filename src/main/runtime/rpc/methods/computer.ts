import { z } from 'zod'
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import { defineMethod, type RpcMethod } from '../core'
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

export function resetComputerSessionsForTest(): void {
  resetComputerSidecarForTest()
}

export const COMPUTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'computer.capabilities',
    params: z.object({}),
    handler: async () => {
      return await callComputerSidecarCapabilities()
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
    params: z.object({}),
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
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    params: PerformSecondaryAction,
    handler: async (params) => {
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
      return await callComputerSidecarAction('setValue', params)
    }
  })
]
