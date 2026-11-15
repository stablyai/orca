import type {
  ComputerActionResult,
  ComputerLaunchAppResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/computer-use-runtime-types'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { queryComputerTreeText } from './computer-tree-query'
import { runComputerWait } from './computer-wait-command'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  formatComputerAction,
  formatGetAppState,
  formatLaunchApp,
  formatListApps,
  formatListWindows
} from './computer-format'
import { printResult } from '../output/command-result-output'
import { getComputerCommandTarget } from './computer-command-target'
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
  getComputerTextActionFlags,
  getComputerTypeTextActionFlags
} from './computer-action-flags'
import { computerTypeTextTargetUnsupportedMessage } from '../../shared/computer-use-type-text-target'

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
    // Agents run this on errors; System Settings over the user's work is only worth it when something is missing.
    const result = await client.call<{
      platform: NodeJS.Platform
      helperAppPath: string | null
      openedSettings: boolean
      launchedHelper: boolean
      launchQueued?: boolean
      permissions?: { id: string; status: string }[]
      nextStep?: string | null
    }>('computer.permissions', id ? { id, skipGranted: true } : {})
    printResult(result, json, (value) => {
      if (value.platform !== 'darwin') {
        return 'Computer-use permission setup is only required on macOS.'
      }
      const firstLine = permissionSetupHeadline(value)
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
  'computer launch-app': async ({ flags, client, json }) => {
    const result = await client.call<ComputerLaunchAppResult>('computer.launchApp', {
      app: getRequiredStringFlag(flags, 'app'),
      ...(flags.get('activate') === true ? { activate: true } : {})
    })
    printResult(result, json, formatLaunchApp)
  },
  'computer list-windows': async ({ flags, client, json }) => {
    const result = await client.call<ComputerListWindowsResult>('computer.listWindows', {
      app: getRequiredStringFlag(flags, 'app')
    })
    printResult(result, json, formatListWindows)
  },
  'computer get-app-state': async ({ flags, client, cwd, json }) => {
    const observeFlags = getComputerObserveFlags(flags)
    const query = getOptionalStringFlag(flags, 'query')
    const maxElements = getOptionalPositiveIntegerFlag(flags, 'max-elements')
    const rootElementIndex = getOptionalNonNegativeIntegerFlag(flags, 'element-index')
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerSnapshotResult>('computer.getAppState', {
      ...target,
      ...observeFlags,
      ...(rootElementIndex === undefined ? {} : { rootElementIndex })
    })
    // Why: older runtimes drop the param and return the whole window, which would look like the subtree.
    if (
      rootElementIndex !== undefined &&
      result.result.snapshot.rootElementIndex !== rootElementIndex
    ) {
      throw new RuntimeClientError(
        'unsupported_capability',
        'This Orca runtime cannot read one element subtree; update Orca, or run get-app-state without --element-index'
      )
    }
    if (query !== undefined || maxElements !== undefined) {
      const { snapshot } = result.result
      snapshot.treeText = queryComputerTreeText(snapshot.treeText, { query, maxElements })
    }
    printResult(result, json, formatGetAppState)
  },
  'computer wait': runComputerWait,
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
    const actionParams = await getComputerTypeTextActionFlags(flags)
    const target = await getComputerCommandTarget(flags, cwd, client)
    if (actionParams.elementIndex !== undefined) {
      // Why: older runtimes strip elementIndex, so ask first rather than type into the focused field.
      const capabilities = await client.call<ComputerProviderCapabilities>(
        'computer.capabilities',
        {}
      )
      const unsupported = computerTypeTextTargetUnsupportedMessage(capabilities.result)
      if (unsupported) {
        throw new RuntimeClientError('unsupported_capability', unsupported)
      }
    }
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
    `  Apps: list=${value.supports.apps.list} bundleIds=${value.supports.apps.bundleIds} pids=${value.supports.apps.pids} launch=${value.supports.apps.launch === true}`,
    `  Windows: list=${value.supports.windows.list} targetById=${value.supports.windows.targetById} targetByIndex=${value.supports.windows.targetByIndex}`,
    `  Observation: screenshot=${value.supports.observation.screenshot} elementFrames=${value.supports.observation.elementFrames} annotatedScreenshot=${value.supports.observation.annotatedScreenshot}`,
    `  Actions: ${Object.entries(value.supports.actions)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(', ')}`,
    ...(value.supports.input ? [`  Input: background=${value.supports.input.background}`] : [])
  ].join('\n')
}

function permissionSetupHeadline(result: {
  launchedHelper: boolean
  launchQueued?: boolean
}): string {
  if (result.launchQueued) {
    return 'Queued Orca Computer Use permission setup; a newer request or a reset may replace it.'
  }
  return result.launchedHelper
    ? 'Opened Orca Computer Use permission setup.'
    : 'Computer Use permissions checked.'
}
