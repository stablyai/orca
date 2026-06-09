import type {
  ComputerActionMetadata,
  ComputerProviderCapabilities
} from '../../shared/runtime-types'

export type NativeMethod =
  | 'handshake'
  | 'listApps'
  | 'listWindows'
  | 'getAppState'
  | 'click'
  | 'performSecondaryAction'
  | 'scroll'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'hotkey'
  | 'pasteText'
  | 'setValue'

export type NativeActionMethod = Exclude<
  NativeMethod,
  'handshake' | 'listApps' | 'listWindows' | 'getAppState'
>

export type BridgeFrame = {
  x: number
  y: number
  width: number
  height: number
}

export type BridgeElement = {
  index: number
  runtimeId?: unknown
  automationId?: string
  name?: string
  controlType?: string
  localizedControlType?: string
  className?: string
  value?: string
  isSelected?: boolean
  nativeWindowHandle?: number
  frame?: BridgeFrame | null
  actions?: string[]
}

export type BridgeSnapshot = {
  snapshotId?: string
  app: {
    name: string
    bundleIdentifier?: string
    bundleId?: string
    pid: number
  }
  windowTitle?: string
  windowId?: number | null
  windowIndex?: number | null
  windowBounds?: BridgeFrame | null
  screenshotPngBase64?: string | null
  screenshotWidth?: number | null
  screenshotHeight?: number | null
  screenshotScale?: number | null
  screenshotError?: {
    code?: string | null
    message?: string | null
  } | null
  coordinateSpace?: 'window'
  truncation?: {
    truncated?: boolean
    maxNodes?: number
    maxDepth?: number
    maxDepthReached?: boolean
  }
  treeLines?: string[]
  focusedSummary?: string | null
  focusedElementId?: number | null
  selectedText?: string | null
  elements?: BridgeElement[]
}

export type BridgeWindow = {
  index: number
  app: {
    name: string
    bundleIdentifier?: string | null
    bundleId?: string | null
    pid: number
  }
  id?: number | null
  title: string
  x?: number | null
  y?: number | null
  width: number
  height: number
  isMinimized?: boolean | null
  isOffscreen?: boolean | null
  screenIndex?: number | null
  platform?: Record<string, unknown>
}

export type BridgeResponse = {
  ok: boolean
  error?: string
  capabilities?: ComputerProviderCapabilities
  apps?: {
    name: string
    bundleIdentifier?: string | null
    bundleId?: string | null
    pid: number
  }[]
  app?: {
    name: string
    bundleIdentifier?: string | null
    bundleId?: string | null
    pid: number
  }
  windows?: BridgeWindow[]
  snapshot?: BridgeSnapshot
  action?: ComputerActionMetadata
}

export type BridgeRequest = {
  tool: string
  app?: string
  element?: BridgeElement
  fromElement?: BridgeElement
  toElement?: BridgeElement
  x?: number
  y?: number
  from_x?: number
  from_y?: number
  to_x?: number
  to_y?: number
  click_count?: number
  mouse_button?: string
  action?: string
  direction?: string
  pages?: number
  text?: string
  key?: string
  value?: string
  windowBounds?: BridgeFrame | null
  windowId?: number
  windowIndex?: number
  noScreenshot?: boolean
  restoreWindow?: boolean
}
