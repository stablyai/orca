import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListApps,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from '../../../computer/sidecar-client'
import type { ComputerActionResult } from '../../../../shared/runtime-types'
import { defineMethod } from '../core'
import { runComputerActionWithActivity } from '../../../desktop-app/desktop-app-agent-control'
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

type TrackedComputerAction = Parameters<typeof callComputerSidecarAction>[0]

// Why: the Desktop App pane shows which app an agent is driving and can stop it.
function runTrackedComputerAction(
  method: TrackedComputerAction,
  params: unknown
): Promise<ComputerActionResult> {
  return runComputerActionWithActivity(
    `computer.${method}`,
    params,
    (runParams) => callComputerSidecarAction(method, runParams),
    async () => (await callComputerSidecarListApps()).apps,
    resolveAppPidWithProvider
  )
}

// Why no catch: this only runs while a stop is active, and an unresolvable selector must fail
// closed instead of skipping the block check.
async function resolveAppPidWithProvider(selector: string): Promise<number | null> {
  return (await callComputerSidecarListWindows({ app: selector })).app.pid ?? null
}

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
      return await runTrackedComputerAction('click', params)
    }
  }),
  defineMethod({
    name: 'computer.performSecondaryAction',
    permission: 'desktop-control',
    params: PerformSecondaryAction,
    handler: async (params) => {
      return await runTrackedComputerAction('performSecondaryAction', params)
    }
  }),
  defineMethod({
    name: 'computer.scroll',
    permission: 'desktop-control',
    params: Scroll,
    handler: async (params) => {
      return await runTrackedComputerAction('scroll', params)
    }
  }),
  defineMethod({
    name: 'computer.drag',
    permission: 'desktop-control',
    params: Drag,
    handler: async (params) => {
      return await runTrackedComputerAction('drag', params)
    }
  }),
  defineMethod({
    name: 'computer.typeText',
    permission: 'desktop-control',
    params: TypeText,
    handler: async (params) => {
      return await runTrackedComputerAction('typeText', params)
    }
  }),
  defineMethod({
    name: 'computer.pressKey',
    permission: 'desktop-control',
    params: PressKey,
    handler: async (params) => {
      return await runTrackedComputerAction('pressKey', params)
    }
  }),
  defineMethod({
    name: 'computer.hotkey',
    permission: 'desktop-control',
    params: Hotkey,
    handler: async (params) => {
      return await runTrackedComputerAction('hotkey', params)
    }
  }),
  defineMethod({
    name: 'computer.pasteText',
    permission: 'desktop-control',
    params: PasteText,
    handler: async (params) => {
      return await runTrackedComputerAction('pasteText', params)
    }
  }),
  defineMethod({
    name: 'computer.setValue',
    permission: 'desktop-control',
    params: SetValue,
    handler: async (params) => {
      return await runTrackedComputerAction('setValue', params)
    }
  })
]
