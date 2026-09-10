import { z } from 'zod'
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
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

const COMPUTER_HOST_ONLY_MESSAGE = 'Computer use is only available on the Orca host runtime.'

function assertHostOnlyClient(clientKind: RpcContext['clientKind'], message: string): void {
  if (clientKind !== undefined) {
    throw new Error(message)
  }
}

export const COMPUTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'computer.capabilities',
    params: z.object({}),
    handler: async (_params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarCapabilities()
    }
  }),
  defineMethod({
    name: 'computer.listApps',
    params: ListApps,
    handler: async (_params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarListApps()
    }
  }),
  defineMethod({
    name: 'computer.permissions',
    params: ComputerPermissions,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      const { openComputerUsePermissions } =
        await import('../../../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(params.id)
    }
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    params: z.object({}),
    handler: async (_params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      const { getComputerUsePermissionStatus } =
        await import('../../../computer/macos-computer-use-permissions')
      return getComputerUsePermissionStatus()
    }
  }),
  defineMethod({
    name: 'computer.listWindows',
    params: ListWindows,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarListWindows(params)
    }
  }),
  defineMethod({
    name: 'computer.getAppState',
    params: ComputerObserveTarget,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarSnapshot(params)
    }
  }),
  defineMethod({
    name: 'computer.click',
    params: Click,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    params: PerformSecondaryAction,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    params: Scroll,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    params: Drag,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    params: TypeText,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    params: PressKey,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    params: Hotkey,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    params: PasteText,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    params: SetValue,
    handler: async (params, { clientKind }) => {
      assertHostOnlyClient(clientKind, COMPUTER_HOST_ONLY_MESSAGE)
      return await callComputerSidecarAction('setValue', params)
    }
  })
]
