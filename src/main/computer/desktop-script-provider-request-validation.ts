import { CLIPBOARD_TEXT_WRITE_MAX_BYTES } from '../../shared/clipboard-text'
import {
  computerUseClickModifiersValidationMessage,
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from '../../shared/computer-use-key-spec'
import type { BridgeElement, BridgeFrame, BridgeRequest } from './desktop-script-provider-types'

export const DESKTOP_PROVIDER_REQUEST_MAX_BYTES = 17 * 1024 * 1024
const SERIALIZED_REQUESTS = new WeakMap<object, string>()

const APP_TARGET_KEYS = ['tool', 'app', 'windowId', 'windowIndex', 'noScreenshot', 'restoreWindow']
const ACTION_BASE_KEYS = [...APP_TARGET_KEYS, 'windowBounds']
const TOOL_KEYS = new Map<string, Set<string>>([
  ['handshake', keys('tool')],
  ['list_apps', keys('tool')],
  ['list_windows', keys('tool', 'app')],
  ['get_app_state', keys(...APP_TARGET_KEYS)],
  [
    'click',
    keys(...ACTION_BASE_KEYS, 'element', 'x', 'y', 'click_count', 'mouse_button', 'modifiers')
  ],
  ['perform_secondary_action', keys(...ACTION_BASE_KEYS, 'element', 'action')],
  ['scroll', keys(...ACTION_BASE_KEYS, 'element', 'x', 'y', 'direction', 'pages')],
  [
    'drag',
    keys(...ACTION_BASE_KEYS, 'fromElement', 'toElement', 'from_x', 'from_y', 'to_x', 'to_y')
  ],
  ['type_text', keys(...ACTION_BASE_KEYS, 'text')],
  ['press_key', keys(...ACTION_BASE_KEYS, 'key')],
  ['hotkey', keys(...ACTION_BASE_KEYS, 'key')],
  ['paste_text', keys(...ACTION_BASE_KEYS, 'text')],
  ['set_value', keys(...ACTION_BASE_KEYS, 'element', 'value')]
])
const ELEMENT_KEYS = keys(
  'index',
  'runtimeId',
  'automationId',
  'name',
  'controlType',
  'localizedControlType',
  'className',
  'value',
  'isSelected',
  'nativeWindowHandle',
  'frame',
  'actions'
)
const FRAME_KEYS = keys('x', 'y', 'width', 'height')

export function isDesktopScriptProviderRequest(value: unknown): value is BridgeRequest {
  const request = record(value)
  if (!request || typeof request.tool !== 'string') {
    return false
  }
  const allowedKeys = TOOL_KEYS.get(request.tool)
  if (!allowedKeys || !hasOnlyKeys(request, allowedKeys) || !isWithinRequestLimit(request)) {
    return false
  }
  if (request.tool === 'handshake' || request.tool === 'list_apps') {
    return true
  }
  if (!isNonEmptyString(request.app)) {
    return false
  }
  if (request.tool === 'list_windows') {
    return true
  }
  if (!hasValidAppTarget(request)) {
    return false
  }
  if (request.tool === 'get_app_state') {
    return true
  }
  if (!isOptionalFrameOrNull(request.windowBounds)) {
    return false
  }
  return hasValidAction(request)
}

export function serializeDesktopScriptProviderRequest(request: BridgeRequest): string {
  const cached = SERIALIZED_REQUESTS.get(request)
  if (cached !== undefined) {
    SERIALIZED_REQUESTS.delete(request)
    return cached
  }
  return JSON.stringify(request)
}

function hasValidAppTarget(request: Record<string, unknown>): boolean {
  return (
    isOptionalFiniteNumber(request.windowId) &&
    isOptionalFiniteNumber(request.windowIndex) &&
    !(request.windowId !== undefined && request.windowIndex !== undefined) &&
    isOptionalBoolean(request.noScreenshot) &&
    isOptionalBoolean(request.restoreWindow)
  )
}

function hasValidAction(request: Record<string, unknown>): boolean {
  switch (request.tool) {
    case 'click':
      return (
        isElementOrCoordinateTarget(request, 'element', 'x', 'y') &&
        isOptionalPositiveInteger(request.click_count) &&
        isOptionalEnum(request.mouse_button, ['left', 'right', 'middle']) &&
        isValidClickModifiers(request.modifiers)
      )
    case 'perform_secondary_action':
      return isElement(request.element) && isNonEmptyString(request.action)
    case 'scroll':
      return (
        isElementOrCoordinateTarget(request, 'element', 'x', 'y') &&
        isOptionalEnum(request.direction, ['up', 'down', 'left', 'right'], true) &&
        isOptionalPositiveNumber(request.pages)
      )
    case 'drag':
      return isDragTarget(request)
    case 'type_text':
      return isNonEmptyString(request.text)
    case 'press_key':
      return (
        isNonEmptyString(request.key) && computerUsePressKeyValidationMessage(request.key) === null
      )
    case 'hotkey':
      return (
        isNonEmptyString(request.key) && computerUseHotkeyValidationMessage(request.key) === null
      )
    case 'paste_text':
      return (
        isNonEmptyString(request.text) &&
        Buffer.byteLength(request.text, 'utf8') <= CLIPBOARD_TEXT_WRITE_MAX_BYTES
      )
    case 'set_value':
      return isElement(request.element) && typeof request.value === 'string'
    default:
      return false
  }
}

function isValidClickModifiers(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (isNonEmptyString(value) && computerUseClickModifiersValidationMessage(value) === null)
  )
}

function isElementOrCoordinateTarget(
  request: Record<string, unknown>,
  elementKey: string,
  xKey: string,
  yKey: string
): boolean {
  const hasElement = request[elementKey] !== undefined
  const hasX = request[xKey] !== undefined
  const hasY = request[yKey] !== undefined
  return (
    hasElement !== (hasX && hasY) &&
    hasX === hasY &&
    (!hasElement || isElement(request[elementKey])) &&
    isOptionalFiniteNumber(request[xKey]) &&
    isOptionalFiniteNumber(request[yKey])
  )
}

function isDragTarget(request: Record<string, unknown>): boolean {
  const hasElements = request.fromElement !== undefined || request.toElement !== undefined
  const coordinates = [request.from_x, request.from_y, request.to_x, request.to_y]
  const hasCoordinates = coordinates.some((value) => value !== undefined)
  if (hasElements === hasCoordinates) {
    return false
  }
  return hasElements
    ? isElement(request.fromElement) && isElement(request.toElement)
    : coordinates.every((value) => typeof value === 'number' && Number.isFinite(value))
}

function isElement(value: unknown): value is BridgeElement {
  const element = record(value)
  return (
    !!element &&
    hasOnlyKeys(element, ELEMENT_KEYS) &&
    Number.isSafeInteger(element.index) &&
    (element.index as number) >= 0 &&
    (element.runtimeId === undefined ||
      (Array.isArray(element.runtimeId) &&
        element.runtimeId.every((part) => Number.isSafeInteger(part)))) &&
    isOptionalString(element.automationId) &&
    isOptionalString(element.name) &&
    isOptionalString(element.controlType) &&
    isOptionalString(element.localizedControlType) &&
    isOptionalString(element.className) &&
    isOptionalString(element.value) &&
    isOptionalBoolean(element.isSelected) &&
    isOptionalFiniteNumber(element.nativeWindowHandle) &&
    isOptionalFrameOrNull(element.frame) &&
    (element.actions === undefined ||
      (Array.isArray(element.actions) &&
        element.actions.every((action) => typeof action === 'string')))
  )
}

function isOptionalFrameOrNull(value: unknown): value is BridgeFrame | null | undefined {
  if (value === undefined || value === null) {
    return true
  }
  const frame = record(value)
  return (
    !!frame &&
    hasOnlyKeys(frame, FRAME_KEYS) &&
    Number.isFinite(frame.x) &&
    Number.isFinite(frame.y) &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height)
  )
}

function isWithinRequestLimit(request: Record<string, unknown>): boolean {
  try {
    const serialized = JSON.stringify(request)
    const withinLimit =
      typeof serialized === 'string' &&
      Buffer.byteLength(serialized, 'utf8') <= DESKTOP_PROVIDER_REQUEST_MAX_BYTES
    if (withinLimit) {
      SERIALIZED_REQUESTS.set(request, serialized)
    }
    return withinLimit
  } catch {
    return false
  }
}

function isOptionalEnum(
  value: unknown,
  allowed: readonly string[],
  required = false
): value is string | undefined {
  return value === undefined ? !required : typeof value === 'string' && allowed.includes(value)
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)
}

function isOptionalPositiveNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function keys(...values: string[]): Set<string> {
  return new Set(values)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
