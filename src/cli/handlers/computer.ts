import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalNumberFlag,
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlagAllowingEmpty,
  getRequiredStringFlag
} from '../flags'
import {
  formatComputerAction,
  formatGetAppState,
  formatListApps,
  formatListWindows,
  printResult
} from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getComputerCommandTarget } from '../selectors'

export const COMPUTER_HANDLERS: Record<string, CommandHandler> = {
  'computer capabilities': async ({ client, json }) => {
    const result = await client.call<ComputerProviderCapabilities>('computer.capabilities', {})
    printResult(result, json, formatComputerCapabilities)
  },
  'computer list-apps': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerListAppsResult>('computer.listApps', {
      worktree: target.worktree
    })
    printResult(result, json, formatListApps)
  },
  'computer permissions': async ({ client, json }) => {
    const result = await client.call<{
      platform: NodeJS.Platform
      helperAppPath: string | null
      openedSettings: boolean
      launchedHelper: boolean
      permissions?: { id: string; status: string }[]
      nextStep?: string | null
    }>('computer.permissions', {})
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
  'computer list-windows': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerListWindowsResult>('computer.listWindows', target)
    printResult(result, json, formatListWindows)
  },
  'computer get-app-state': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerSnapshotResult>('computer.getAppState', {
      ...target,
      noScreenshot: flags.has('no-screenshot') ? true : undefined,
      restoreWindow: flags.has('restore-window') ? true : undefined,
      windowId: getOptionalNumberFlag(flags, 'window-id'),
      windowIndex: getOptionalNonNegativeIntegerFlag(flags, 'window-index')
    })
    printResult(result, json, formatGetAppState)
  },
  'computer click': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.click', {
      ...target,
      elementIndex: getOptionalNonNegativeIntegerFlag(flags, 'element-index'),
      x: getOptionalNumberFlag(flags, 'x'),
      y: getOptionalNumberFlag(flags, 'y'),
      clickCount: getOptionalPositiveIntegerFlag(flags, 'click-count'),
      mouseButton: getOptionalStringFlag(flags, 'mouse-button'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('click', value))
  },
  'computer perform-secondary-action': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.performSecondaryAction', {
      ...target,
      elementIndex: getRequiredNonNegativeIntegerFlag(flags, 'element-index'),
      action: getRequiredStringFlag(flags, 'action'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('perform-secondary-action', value))
  },
  'computer scroll': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.scroll', {
      ...target,
      elementIndex: getOptionalNonNegativeIntegerFlag(flags, 'element-index'),
      x: getOptionalNumberFlag(flags, 'x'),
      y: getOptionalNumberFlag(flags, 'y'),
      direction: getRequiredStringFlag(flags, 'direction'),
      pages: getOptionalPositiveNumberFlag(flags, 'pages'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('scroll', value))
  },
  'computer drag': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.drag', {
      ...target,
      fromElementIndex: getOptionalNonNegativeIntegerFlag(flags, 'from-element-index'),
      toElementIndex: getOptionalNonNegativeIntegerFlag(flags, 'to-element-index'),
      fromX: getOptionalNumberFlag(flags, 'from-x'),
      fromY: getOptionalNumberFlag(flags, 'from-y'),
      toX: getOptionalNumberFlag(flags, 'to-x'),
      toY: getOptionalNumberFlag(flags, 'to-y'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('drag', value))
  },
  'computer type-text': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.typeText', {
      ...target,
      text: await getTextPayload(flags, 'text'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('type-text', value))
  },
  'computer press-key': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.pressKey', {
      ...target,
      key: getRequiredStringFlag(flags, 'key'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('press-key', value))
  },
  'computer hotkey': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.hotkey', {
      ...target,
      key: getRequiredStringFlag(flags, 'key'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('hotkey', value))
  },
  'computer paste-text': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.pasteText', {
      ...target,
      text: await getTextPayload(flags, 'text'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('paste-text', value))
  },
  'computer set-value': async ({ flags, client, cwd, json }) => {
    const target = await getComputerCommandTarget(flags, cwd, client)
    const result = await client.call<ComputerActionResult>('computer.setValue', {
      ...target,
      elementIndex: getRequiredNonNegativeIntegerFlag(flags, 'element-index'),
      value: await getTextPayload(flags, 'value'),
      ...getComputerActionObserveFlags(flags)
    })
    printResult(result, json, (value) => formatComputerAction('set-value', value))
  }
}

async function getTextPayload(
  flags: Map<string, string | boolean>,
  name: 'text' | 'value'
): Promise<string> {
  const stdinFlag = `${name}-stdin`
  if (flags.has(stdinFlag)) {
    if (flags.has(name)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Use either --${name} or --${stdinFlag}, not both`
      )
    }
    return await readStdin()
  }
  return name === 'value'
    ? getRequiredStringFlagAllowingEmpty(flags, name)
    : getRequiredStringFlag(flags, name)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin payload requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function getOptionalPositiveNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (value <= 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid positive number for --${name}`)
  }
  return value
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

function getRequiredNonNegativeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number {
  const value = getOptionalNonNegativeIntegerFlag(flags, name)
  if (value === undefined) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function getComputerActionObserveFlags(flags: Map<string, string | boolean>): {
  noScreenshot?: boolean
  restoreWindow?: boolean
  windowId?: number
  windowIndex?: number
} {
  const observeFlags: {
    noScreenshot?: boolean
    restoreWindow?: boolean
    windowId?: number
    windowIndex?: number
  } = {
    noScreenshot: flags.has('no-screenshot') ? true : undefined
  }
  if (flags.has('restore-window')) {
    observeFlags.restoreWindow = true
  }
  const windowId = getOptionalNumberFlag(flags, 'window-id')
  if (windowId !== undefined) {
    observeFlags.windowId = windowId
  }
  const windowIndex = getOptionalNonNegativeIntegerFlag(flags, 'window-index')
  if (windowIndex !== undefined) {
    observeFlags.windowIndex = windowIndex
  }
  return observeFlags
}
