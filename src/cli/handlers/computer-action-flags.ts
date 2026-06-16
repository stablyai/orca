import {
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from '../../shared/computer-use-key-spec'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  validateDragTarget,
  validateElementOrCoordinates,
  validateExclusiveWindowTarget,
  validateMouseButton,
  validateScrollDirection
} from './computer-action-flag-validation'

export function getComputerWindowTargetFlags(flags: Map<string, string | boolean>): {
  windowId?: number
  windowIndex?: number
} {
  const windowId = getOptionalNonNegativeIntegerFlag(flags, 'window-id')
  const windowIndex = getOptionalNonNegativeIntegerFlag(flags, 'window-index')
  validateExclusiveWindowTarget(windowId, windowIndex)
  return {
    ...(windowId !== undefined ? { windowId } : {}),
    ...(windowIndex !== undefined ? { windowIndex } : {})
  }
}

export function getComputerObserveFlags(flags: Map<string, string | boolean>): {
  noScreenshot?: boolean
  restoreWindow?: boolean
  windowId?: number
  windowIndex?: number
} {
  return {
    noScreenshot: flags.has('no-screenshot') ? true : undefined,
    ...(flags.has('restore-window') ? { restoreWindow: true } : {}),
    ...getComputerWindowTargetFlags(flags)
  }
}

export function getComputerActionObserveFlags(flags: Map<string, string | boolean>): {
  noScreenshot?: boolean
  restoreWindow?: boolean
  windowId?: number
  windowIndex?: number
} {
  return getComputerObserveFlags(flags)
}

export function getComputerClickActionFlags(flags: Map<string, string | boolean>): {
  elementIndex?: number
  x?: number
  y?: number
  clickCount?: number
  mouseButton?: string
} {
  const result = {
    elementIndex: getOptionalNonNegativeIntegerFlag(flags, 'element-index'),
    x: getOptionalNumberFlag(flags, 'x'),
    y: getOptionalNumberFlag(flags, 'y'),
    clickCount: getOptionalPositiveIntegerFlag(flags, 'click-count'),
    mouseButton: getOptionalStringFlag(flags, 'mouse-button')
  }
  validateElementOrCoordinates('Click', result.elementIndex, result.x, result.y)
  validateMouseButton(result.mouseButton)
  return result
}

export function getComputerSecondaryActionFlags(flags: Map<string, string | boolean>): {
  elementIndex: number
  action: string
} {
  return {
    elementIndex: getRequiredNonNegativeIntegerFlag(flags, 'element-index'),
    action: getRequiredStringFlag(flags, 'action')
  }
}

export function getComputerScrollActionFlags(flags: Map<string, string | boolean>): {
  elementIndex?: number
  x?: number
  y?: number
  direction: string
  pages?: number
} {
  const result = {
    elementIndex: getOptionalNonNegativeIntegerFlag(flags, 'element-index'),
    x: getOptionalNumberFlag(flags, 'x'),
    y: getOptionalNumberFlag(flags, 'y'),
    direction: getRequiredStringFlag(flags, 'direction'),
    pages: getOptionalPositiveNumberFlag(flags, 'pages')
  }
  validateElementOrCoordinates('Scroll', result.elementIndex, result.x, result.y)
  validateScrollDirection(result.direction)
  return result
}

export function getComputerDragActionFlags(flags: Map<string, string | boolean>): {
  fromElementIndex?: number
  toElementIndex?: number
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
} {
  const result = {
    fromElementIndex: getOptionalNonNegativeIntegerFlag(flags, 'from-element-index'),
    toElementIndex: getOptionalNonNegativeIntegerFlag(flags, 'to-element-index'),
    fromX: getOptionalNumberFlag(flags, 'from-x'),
    fromY: getOptionalNumberFlag(flags, 'from-y'),
    toX: getOptionalNumberFlag(flags, 'to-x'),
    toY: getOptionalNumberFlag(flags, 'to-y')
  }
  validateDragTarget(result)
  return result
}

export async function getComputerTextActionFlags(flags: Map<string, string | boolean>): Promise<{
  text: string
}> {
  return { text: await getTextPayload(flags, 'text') }
}

export function getComputerKeyActionFlags(flags: Map<string, string | boolean>): {
  key: string
} {
  const key = getRequiredStringFlag(flags, 'key')
  const message = computerUsePressKeyValidationMessage(key)
  if (message) {
    throw new RuntimeClientError('invalid_argument', message)
  }
  return { key }
}

export function getComputerHotkeyActionFlags(flags: Map<string, string | boolean>): {
  key: string
} {
  const key = getRequiredStringFlag(flags, 'key')
  const message = computerUseHotkeyValidationMessage(key)
  if (message) {
    throw new RuntimeClientError('invalid_argument', message)
  }
  return { key }
}

export async function getComputerSetValueActionFlags(
  flags: Map<string, string | boolean>
): Promise<{
  elementIndex: number
  value: string
}> {
  return {
    elementIndex: getRequiredNonNegativeIntegerFlag(flags, 'element-index'),
    value: await getTextPayload(flags, 'value')
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
    const payload = await readStdin()
    if (name === 'text' && payload.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing text from stdin')
    }
    return payload
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
