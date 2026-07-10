import {
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from '../../shared/computer-use-key-spec'
import { validateComputerClipboardPasteTextWithBoundedYield } from './computer-clipboard-paste-validation'
import { RuntimeClientError } from './runtime-client-error'

type ComputerProviderActionMethod =
  | 'click'
  | 'performSecondaryAction'
  | 'scroll'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'hotkey'
  | 'pasteText'
  | 'setValue'

export async function validateComputerProviderActionParams(
  method: ComputerProviderActionMethod,
  params: Record<string, unknown>
): Promise<string> {
  const app = requireNonEmptyString(params, 'app')
  validateWindowTarget(params)
  switch (method) {
    case 'click':
      validateElementOrCoordinates('Click', params)
      validatePositiveInteger(params, 'clickCount')
      validateMouseButton(params)
      return app
    case 'performSecondaryAction':
      requireNonNegativeInteger(params, 'elementIndex')
      requireNonEmptyString(params, 'action')
      return app
    case 'scroll':
      validateElementOrCoordinates('Scroll', params)
      validateScrollDirection(params)
      validatePositiveNumber(params, 'pages')
      return app
    case 'drag':
      validateDragTarget(params)
      return app
    case 'typeText':
      requireNonEmptyString(params, 'text')
      return app
    case 'pasteText':
      await validatePasteText(params)
      return app
    case 'pressKey':
      validatePressKey(params)
      return app
    case 'hotkey':
      validateHotkey(params)
      return app
    case 'setValue':
      requireNonNegativeInteger(params, 'elementIndex')
      requireStringAllowingEmpty(params, 'value')
      return app
  }
}

function validateWindowTarget(params: Record<string, unknown>): void {
  if (params.windowId !== undefined && params.windowIndex !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Window targeting accepts either windowId or windowIndex, not both'
    )
  }
}

function validateElementOrCoordinates(
  actionName: 'Click' | 'Scroll',
  params: Record<string, unknown>
): void {
  const hasElement = params.elementIndex !== undefined
  const hasX = params.x !== undefined
  const hasY = params.y !== undefined
  if (!hasElement && !(hasX && hasY)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} requires elementIndex or both x and y`
    )
  }
  if (hasX !== hasY) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} coordinates require both x and y`
    )
  }
  if (hasElement && (hasX || hasY)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${actionName} accepts either elementIndex or coordinate fields, not both`
    )
  }
  if (params.elementIndex !== undefined) {
    requireNonNegativeInteger(params, 'elementIndex')
  }
  requireFiniteNumber(params, 'x')
  requireFiniteNumber(params, 'y')
}

function validateDragTarget(params: Record<string, unknown>): void {
  const hasElementPair =
    params.fromElementIndex !== undefined && params.toElementIndex !== undefined
  const hasPartialElementPair =
    params.fromElementIndex !== undefined || params.toElementIndex !== undefined
  const coordinates = [params.fromX, params.fromY, params.toX, params.toY]
  const hasCoordinatePair = coordinates.every((coordinate) => coordinate !== undefined)
  const hasPartialCoordinatePair = coordinates.some((coordinate) => coordinate !== undefined)
  if (hasElementPair && hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag accepts either element indexes or coordinate fields, not both'
    )
  }
  if (hasPartialElementPair && !hasElementPair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag element targeting requires both fromElementIndex and toElementIndex'
    )
  }
  if (hasPartialCoordinatePair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag coordinates require fromX, fromY, toX, and toY'
    )
  }
  if (!hasElementPair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Drag requires fromElementIndex and toElementIndex, or all coordinate fields'
    )
  }
  if (hasElementPair) {
    requireNonNegativeInteger(params, 'fromElementIndex')
    requireNonNegativeInteger(params, 'toElementIndex')
  }
  if (hasCoordinatePair) {
    requireFiniteNumber(params, 'fromX')
    requireFiniteNumber(params, 'fromY')
    requireFiniteNumber(params, 'toX')
    requireFiniteNumber(params, 'toY')
  }
}

function validateMouseButton(params: Record<string, unknown>): void {
  const mouseButton = params.mouseButton
  if (
    mouseButton !== undefined &&
    mouseButton !== 'left' &&
    mouseButton !== 'right' &&
    mouseButton !== 'middle'
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Unsupported mouseButton; expected left, right, or middle'
    )
  }
}

function validateScrollDirection(params: Record<string, unknown>): void {
  const direction = requireNonEmptyString(params, 'direction')
  if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Unsupported direction; expected up, down, left, or right'
    )
  }
}

function validatePressKey(params: Record<string, unknown>): void {
  const key = requireNonEmptyString(params, 'key')
  const message = computerUsePressKeyValidationMessage(key)
  if (message) {
    throw new RuntimeClientError('invalid_argument', message)
  }
}

function validateHotkey(params: Record<string, unknown>): void {
  const key = requireNonEmptyString(params, 'key')
  const message = computerUseHotkeyValidationMessage(key)
  if (message) {
    throw new RuntimeClientError('invalid_argument', message)
  }
}

function validatePasteText(params: Record<string, unknown>): Promise<void> | void {
  const text = requireNonEmptyString(params, 'text')
  return validateComputerClipboardPasteTextWithBoundedYield(text)
}

function requireStringAllowingEmpty(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', `Missing ${key}`)
  }
  return value
}

function requireNonEmptyString(params: Record<string, unknown>, key: string): string {
  const value = requireStringAllowingEmpty(params, key)
  if (value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing ${key}`)
  }
  return value
}

function requireNonNegativeInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError('invalid_argument', `${key} must be a non-negative integer`)
  }
  return value
}

function requireFiniteNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RuntimeClientError('invalid_argument', `${key} must be a finite number`)
  }
  return value
}

function validatePositiveInteger(params: Record<string, unknown>, key: string): void {
  const value = params[key]
  if (value === undefined) {
    return
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `${key} must be a positive integer`)
  }
}

function validatePositiveNumber(params: Record<string, unknown>, key: string): void {
  const value = params[key]
  if (value === undefined) {
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `${key} must be a positive number`)
  }
}
