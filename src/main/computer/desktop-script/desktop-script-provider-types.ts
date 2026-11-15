import type {
  ComputerActionMetadata,
  ComputerProviderCapabilities
} from '../../../shared/computer-use-runtime-types'

export type NativeMethod =
  | 'handshake'
  | 'listApps'
  | 'launchApp'
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
  'handshake' | 'listApps' | 'launchApp' | 'listWindows' | 'getAppState'
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
  isDisabled?: boolean
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
  /** Set by the client when treeLines show only this element's subtree. */
  rootElementIndex?: number
  /** Cache only: for elements a subtree read returned, the root of the latest read that returned them. */
  subtreeReadRoots?: ReadonlyMap<number, number>
  /** Cache only: the next index a subtree read may assign, so dropped indexes are never reused. */
  nextElementIndex?: number
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
  /** Echo of BridgeRequest.requestId; set only on the persistent serve path. */
  requestId?: number
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
  /** launch_app: false when the app was already running. */
  launched?: boolean
  delivery?: 'background' | 'foreground'
  snapshot?: BridgeSnapshot
  action?: ComputerActionMetadata
}

export type BridgeRequest = {
  tool: string
  /** Correlates a serve-mode reply with its request; the one-shot path omits it. */
  requestId?: number
  app?: string
  element?: BridgeElement
  /** get_app_state renders only this element's subtree. */
  root?: BridgeElement
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
  modifiers?: string
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
  /** launch_app: let the started app take the foreground. */
  activate?: boolean
}
