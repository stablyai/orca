import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  formatComputerAction,
  formatGetAppState,
  formatListApps,
  formatListWindows,
  printResult
} from '../format'
import { getComputerCommandTarget } from '../selectors'
import {
  getComputerActionObserveFlags,
  getComputerObserveFlags,
  getComputerClickActionFlags,
  getComputerDragActionFlags,
  getComputerHotkeyActionFlags,
  getComputerKeyActionFlags,
  getComputerScrollActionFlags,
  getComputerSecondaryActionFlags,
  getComputerSetValueActionFlags,
  getComputerTextActionFlags
} from './computer-action-flags'

export const COMPUTER_HANDLERS: Record<string, CommandHandler> = {
  'computer capabilities': async ({ client, json }) => {
    const result = await client.call<ComputerProviderCapabilities>('computer.capabilities', {})
    printResult(result, json, formatComputerCapabilities)
  },
  'computer list-apps': async ({ client, json }) => {
    const result = await client.call<ComputerListAppsResult>('computer.listApps', {})
    printResult(result, json, formatListApps)
  },
  'computer permissions': async ({ flags, client, json }) => {
    const id = getComputerPermissionSetupId(flags)
    const result = await client.call<{
      platform: NodeJS.Platform
      helperAppPath: string | null
      openedSettings: boolean
      launchedHelper: boolean
      permissions?: { id: string; status: string }[]
      nextStep?: string | null
    }>('computer.permissions', id ? { id } : {})
    printResult(result, json, (value) => {
      if (value.platform !== 'darwin') {
        return 'Computer-use permission setup is only required on macOS.'
      }
      const firstLine = value.launchedHelper
        ? 'Opened Orca Computer Use permission setup.'
        : 'Computer Use permissions checked.'
      return [
        firstLine,
        `Helper app: ${value.helperAppPath}`,
        `Permissions: ${value.permissions?.map((permission) => `${permission.id}=${permission.status}`).join(', ') ?? 'unknown'}`,
        value.nextStep
          ? `Next: ${value.nextStep}`
          : 'Computer Use permissions are already granted.',
        value.launchedHelper
          ? 'Use the Allow buttons or drag "Orca Computer Use" into the macOS permission list.'
          : null
      ]
        .filter((line) => line !== null)
        .join('\n')
    })
  },
  'computer list-windows': async ({ flags, client, json }) => {
    const result = await client.call<ComputerListWindowsResult>('computer.listWindows', {
      app: getRequiredStringFlag(flags, 'app')
    })
    printResult(result, json, formatListWindows)
  },
  'computer get-app-state': async ({ flags, client, cwd, json }) => {
    const observeFlags = getComputerObserveFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerSnapshotResult>('computer.getAppState', {
      ...target,
      ...observeFlags
    })
    printResult(result, json, formatGetAppState)
  },
  'computer click': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerClickActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.click', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('click', value, { ...target, ...observeFlags })
    )
  },
  'computer perform-secondary-action': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerSecondaryActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.performSecondaryAction', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('perform-secondary-action', value, { ...target, ...observeFlags })
    )
  },
  'computer scroll': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerScrollActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.scroll', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('scroll', value, { ...target, ...observeFlags })
    )
  },
  'computer drag': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerDragActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.drag', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('drag', value, { ...target, ...observeFlags })
    )
  },
  'computer type-text': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = await getComputerTextActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.typeText', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('type-text', value, { ...target, ...observeFlags })
    )
  },
  'computer press-key': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerKeyActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.pressKey', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('press-key', value, { ...target, ...observeFlags })
    )
  },
  'computer hotkey': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = getComputerHotkeyActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.hotkey', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('hotkey', value, { ...target, ...observeFlags })
    )
  },
  'computer paste-text': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = await getComputerTextActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.pasteText', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('paste-text', value, { ...target, ...observeFlags })
    )
  },
  'computer set-value': async ({ flags, client, cwd, json }) => {
    assertComputerAppFlag(flags)
    const observeFlags = getComputerActionObserveFlags(flags)
    const actionParams = await getComputerSetValueActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.setValue', {
      ...target,
      ...actionParams,
      ...observeFlags
    })
    printResult(result, json, (value) =>
      formatComputerAction('set-value', value, { ...target, ...observeFlags })
    )
  }
}

function assertComputerAppFlag(flags: Map<string, string | boolean>): void {
  getRequiredStringFlag(flags, 'app')
}

function getComputerPermissionSetupId(
  flags: Map<string, string | boolean>
): 'accessibility' | 'screenshots' | undefined {
  const id = getOptionalStringFlag(flags, 'id')
  if (id === undefined || id === 'accessibility' || id === 'screenshots') {
    return id
  }
  throw new RuntimeClientError('invalid_argument', '--id must be "accessibility" or "screenshots"')
}

function formatComputerCapabilities(value: ComputerProviderCapabilities): string {
  return [
    `${value.provider} (${value.platform}, protocol ${value.protocolVersion})`,
    `  Apps: list=${value.supports.apps.list} bundleIds=${value.supports.apps.bundleIds} pids=${value.supports.apps.pids}`,
    `  Windows: list=${value.supports.windows.list} targetById=${value.supports.windows.targetById} targetByIndex=${value.supports.windows.targetByIndex}`,
    `  Observation: screenshot=${value.supports.observation.screenshot} elementFrames=${value.supports.observation.elementFrames} annotatedScreenshot=${value.supports.observation.annotatedScreenshot}`,
    `  Actions: ${Object.entries(value.supports.actions)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(', ')}`
  ].join('\n')
}
