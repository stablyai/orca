/* eslint-disable max-lines -- Why: bridge schema, request mapping, and result normalization stay together so platform scripts have one audited contract. */
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  ComputerActionMetadata,
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import {
  desktopScriptPlatform,
  resolveDesktopScriptProviderPath,
  type DesktopScriptPlatform
} from './desktop-script-provider-paths'
import { RuntimeClientError } from './runtime-client-error'

type NativeMethod =
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

type NativeActionMethod = Exclude<
  NativeMethod,
  'handshake' | 'listApps' | 'listWindows' | 'getAppState'
>

type BridgeFrame = {
  x: number
  y: number
  width: number
  height: number
}

type BridgeElement = {
  index: number
  runtimeId?: unknown
  automationId?: string
  name?: string
  controlType?: string
  localizedControlType?: string
  className?: string
  value?: string
  nativeWindowHandle?: number
  frame?: BridgeFrame | null
  actions?: string[]
}

type BridgeSnapshot = {
  snapshotId?: string
  app: {
    name: string
    bundleIdentifier?: string
    bundleId?: string
    pid: number
  }
  windowTitle?: string
  windowId?: number | null
  windowBounds?: BridgeFrame | null
  screenshotPngBase64?: string | null
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

type BridgeWindow = {
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

type BridgeResponse = {
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

type BridgeRequest = {
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

const REQUEST_TIMEOUT_MS = 30_000

export function shouldUseDesktopScriptProvider(): boolean {
  return desktopScriptPlatform() !== null && resolveDesktopScriptProviderPath() !== null
}

export class DesktopScriptProviderClient {
  private readonly snapshots = new Map<string, BridgeSnapshot>()
  private providerCapabilities: ComputerProviderCapabilities | null = null

  constructor(
    private readonly platform: DesktopScriptPlatform = requiredPlatform(),
    private readonly scriptPath: string = requiredScriptPath()
  ) {}

  async listApps(): Promise<ComputerListAppsResult> {
    const response = await this.callBridge({ tool: 'list_apps' })
    return {
      apps: (response.apps ?? []).map((app) => ({
        name: app.name,
        bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
        pid: app.pid,
        isRunning: true,
        lastUsedAt: null,
        useCount: null
      }))
    }
  }

  async capabilities(): Promise<ComputerProviderCapabilities> {
    return await this.readCapabilities()
  }

  async listWindows(params: Record<string, unknown>): Promise<ComputerListWindowsResult> {
    const capabilities = await this.readCapabilities()
    if (!capabilities.supports.windows.list) {
      throw new RuntimeClientError(
        'unsupported_capability',
        `${capabilities.provider} does not support windows.list`
      )
    }
    const response = await this.callBridge({
      tool: 'list_windows',
      app: stringParam(params, 'app')
    })
    return {
      app: normalizeBridgeApp(response.app),
      windows: (response.windows ?? []).map((window) => ({
        index: window.index,
        app: normalizeBridgeApp(window.app),
        id: window.id ?? null,
        title: window.title,
        x: window.x ?? null,
        y: window.y ?? null,
        width: window.width,
        height: window.height,
        isMinimized: window.isMinimized ?? null,
        isOffscreen: window.isOffscreen ?? null,
        screenIndex: window.screenIndex ?? null,
        platform: window.platform
      }))
    }
  }

  async snapshot(params: Record<string, unknown>): Promise<ComputerSnapshotResult> {
    const app = stringParam(params, 'app')
    const response = await this.callBridge({
      tool: 'get_app_state',
      app,
      windowId: optionalNumberParam(params, 'windowId'),
      windowIndex: optionalNumberParam(params, 'windowIndex'),
      noScreenshot: params.noScreenshot === true,
      restoreWindow: params.restoreWindow === true
    })
    return this.rememberAndRender(app, response, params.noScreenshot === true, params)
  }

  async action(
    method: NativeActionMethod,
    params: Record<string, unknown>
  ): Promise<ComputerActionResult> {
    const app = stringParam(params, 'app')
    await this.ensureActionSupported(method)
    const explicitWindowId = optionalNumberParam(params, 'windowId')
    const explicitWindowIndex = optionalNumberParam(params, 'windowIndex')
    const current = this.currentSnapshot(app, explicitWindowId, params)
    const element = elementParam(current, optionalNumberParam(params, 'elementIndex'))
    const fromElement = elementParam(current, optionalNumberParam(params, 'fromElementIndex'))
    const toElement = elementParam(current, optionalNumberParam(params, 'toElementIndex'))
    const response = await this.callBridge({
      tool: bridgeTool(method),
      app,
      element,
      fromElement,
      toElement,
      x: optionalNumberParam(params, 'x'),
      y: optionalNumberParam(params, 'y'),
      from_x: optionalNumberParam(params, 'fromX'),
      from_y: optionalNumberParam(params, 'fromY'),
      to_x: optionalNumberParam(params, 'toX'),
      to_y: optionalNumberParam(params, 'toY'),
      click_count: optionalNumberParam(params, 'clickCount'),
      mouse_button: optionalStringParam(params, 'mouseButton'),
      action: optionalStringParam(params, 'action'),
      direction: optionalStringParam(params, 'direction'),
      pages: optionalNumberParam(params, 'pages'),
      text: optionalStringParam(params, 'text'),
      key: optionalStringParam(params, 'key'),
      value: optionalStringParam(params, 'value'),
      windowBounds: null,
      windowId: explicitWindowId ?? current?.windowId ?? undefined,
      windowIndex: explicitWindowIndex,
      noScreenshot: params.noScreenshot === true,
      restoreWindow: params.restoreWindow === true
    })
    return {
      ...this.rememberAndRender(app, response, params.noScreenshot === true, params),
      action:
        response.action ??
        desktopActionMetadata(method, response.snapshot?.windowId ?? current?.windowId ?? null)
    }
  }

  private async ensureActionSupported(method: NativeActionMethod): Promise<void> {
    if (method !== 'hotkey' && method !== 'pasteText') {
      return
    }
    const capabilities = await this.readCapabilities()
    const actionKey = actionCapabilityKey(method)
    if (!capabilities.supports.actions[actionKey]) {
      throw new RuntimeClientError(
        'unsupported_capability',
        `${capabilities.provider} does not support actions.${actionKey}`
      )
    }
  }

  private async callBridge(request: BridgeRequest): Promise<BridgeResponse> {
    const operationDirectory = await mkdtemp(join(tmpdir(), 'orca-computer-use-'))
    const operationPath = join(operationDirectory, 'operation.json')
    try {
      await writeFile(operationPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 })
      const { stdout, stderr } = await execBridge(this.platform, this.scriptPath, operationPath)
      let response: BridgeResponse
      try {
        response = JSON.parse(stdout) as BridgeResponse
      } catch (error) {
        throw new RuntimeClientError(
          'accessibility_error',
          `desktop provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (!response.ok) {
        throw mapBridgeError(response.error ?? stderr)
      }
      return response
    } finally {
      await rm(operationDirectory, { force: true, recursive: true })
    }
  }

  private async readCapabilities(): Promise<ComputerProviderCapabilities> {
    if (this.providerCapabilities) {
      return this.providerCapabilities
    }
    const response = await this.callBridge({ tool: 'handshake' })
    if (!response.capabilities) {
      throw new RuntimeClientError(
        'accessibility_error',
        'desktop provider returned no capabilities'
      )
    }
    this.providerCapabilities = response.capabilities
    return response.capabilities
  }

  private rememberAndRender(
    app: string,
    response: BridgeResponse,
    noScreenshot: boolean,
    params: Record<string, unknown>
  ): ComputerSnapshotResult {
    if (!response.snapshot) {
      throw new RuntimeClientError('accessibility_error', 'desktop provider returned no snapshot')
    }
    this.rememberSnapshot(app, response.snapshot, params)
    return renderSnapshot(response.snapshot, noScreenshot)
  }

  private rememberSnapshot(
    query: string,
    snapshot: BridgeSnapshot,
    params: Record<string, unknown>
  ): void {
    const namespace = snapshotNamespace(params)
    for (const key of [
      query,
      snapshot.app.name,
      snapshot.app.bundleId,
      snapshot.app.bundleIdentifier,
      String(snapshot.app.pid),
      ...snapshotKeysForWindow(query, snapshot),
      ...snapshotKeysForWindow(snapshot.app.name, snapshot),
      ...(snapshot.app.bundleId ? snapshotKeysForWindow(snapshot.app.bundleId, snapshot) : []),
      ...(snapshot.app.bundleIdentifier
        ? snapshotKeysForWindow(snapshot.app.bundleIdentifier, snapshot)
        : []),
      ...snapshotKeysForWindowIndex(query, params),
      ...snapshotKeysForWindowIndex(snapshot.app.name, params),
      ...(snapshot.app.bundleId ? snapshotKeysForWindowIndex(snapshot.app.bundleId, params) : []),
      ...(snapshot.app.bundleIdentifier
        ? snapshotKeysForWindowIndex(snapshot.app.bundleIdentifier, params)
        : [])
    ]) {
      if (key) {
        if (!isExplicitSnapshotNamespace(namespace)) {
          this.snapshots.set(key.toLowerCase(), snapshot)
        }
        this.snapshots.set(namespacedSnapshotKey(namespace, key), snapshot)
      }
    }
  }

  private currentSnapshot(
    app: string,
    windowId: number | undefined,
    params: Record<string, unknown>
  ): BridgeSnapshot | null {
    const namespace = snapshotNamespace(params)
    if (windowId !== undefined) {
      const windowKey = snapshotWindowKey(app, windowId)
      return (
        this.snapshots.get(namespacedSnapshotKey(namespace, windowKey)) ??
        (isExplicitSnapshotNamespace(namespace) ? undefined : this.snapshots.get(windowKey)) ??
        null
      )
    }
    const windowIndex = optionalNumberParam(params, 'windowIndex')
    if (windowIndex !== undefined) {
      const windowIndexKey = snapshotWindowIndexKey(app, windowIndex)
      return (
        this.snapshots.get(namespacedSnapshotKey(namespace, windowIndexKey)) ??
        (isExplicitSnapshotNamespace(namespace) ? undefined : this.snapshots.get(windowIndexKey)) ??
        null
      )
    }
    return (
      this.snapshots.get(namespacedSnapshotKey(namespace, app)) ??
      (isExplicitSnapshotNamespace(namespace)
        ? undefined
        : this.snapshots.get(app.toLowerCase())) ??
      null
    )
  }
}

function execBridge(
  platform: DesktopScriptPlatform,
  scriptPath: string,
  operationPath: string
): Promise<{ stdout: string; stderr: string }> {
  const command = platform === 'windows' ? 'powershell.exe' : 'python3'
  const args =
    platform === 'windows'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          operationPath
        ]
      : [scriptPath, operationPath]
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
        timeout: REQUEST_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message
          reject(
            error.killed
              ? new RuntimeClientError('action_timeout', message)
              : mapBridgeError(message)
          )
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

function renderSnapshot(snapshot: BridgeSnapshot, noScreenshot: boolean): ComputerSnapshotResult {
  const bounds = snapshot.windowBounds
  const treeText = renderTreeText(snapshot)
  const screenshot = snapshot.screenshotPngBase64
    ? {
        data: snapshot.screenshotPngBase64,
        format: 'png' as const,
        width: Math.max(1, Math.round(bounds?.width ?? 1)),
        height: Math.max(1, Math.round(bounds?.height ?? 1)),
        scale: 1
      }
    : null
  return {
    snapshot: {
      // Why: bridge elements can be large; keep them cached internally for actions
      // instead of returning duplicated metadata in every agent-facing snapshot.
      id: snapshot.snapshotId ?? fallbackSnapshotId(snapshot),
      app: {
        name: snapshot.app.name,
        bundleId: snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? null,
        pid: snapshot.app.pid
      },
      window: {
        title: snapshot.windowTitle ?? snapshot.app.name,
        id: snapshot.windowId ?? null,
        x: bounds ? Math.round(bounds.x) : null,
        y: bounds ? Math.round(bounds.y) : null,
        width: Math.max(0, Math.round(bounds?.width ?? 0)),
        height: Math.max(0, Math.round(bounds?.height ?? 0)),
        isMinimized: null,
        isOffscreen: null,
        screenIndex: null
      },
      coordinateSpace: snapshot.coordinateSpace ?? 'window',
      treeText,
      elementCount: snapshot.elements?.length ?? 0,
      focusedElementId: snapshot.focusedElementId ?? null,
      truncation: {
        truncated: snapshot.truncation?.truncated === true,
        maxNodes: snapshot.truncation?.maxNodes,
        maxDepth: snapshot.truncation?.maxDepth,
        maxDepthReached: snapshot.truncation?.maxDepthReached === true
      }
    },
    screenshot,
    screenshotStatus: screenshot
      ? {
          state: 'captured',
          metadata: { engine: 'unknown', windowId: snapshot.windowId ?? null }
        }
      : noScreenshot
        ? { state: 'skipped', reason: 'no_screenshot_flag' }
        : {
            state: 'failed',
            code: 'screenshot_failed',
            message:
              'desktop provider returned no image; grant screen capture permission or pass --no-screenshot to inspect accessibility state only.'
          }
  }
}

function fallbackSnapshotId(snapshot: BridgeSnapshot): string {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name
  return `${appRef}:${snapshot.app.pid}:${snapshot.windowId ?? 'window'}`
}

function renderTreeText(snapshot: BridgeSnapshot): string {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name
  const lines = [
    `App=${appRef} (pid ${snapshot.app.pid})`,
    `Window: "${sanitize(snapshot.windowTitle ?? snapshot.app.name)}", App: ${sanitize(snapshot.app.name)}.`,
    '',
    ...(snapshot.treeLines ?? [])
  ]
  if (snapshot.selectedText) {
    lines.push('', `Selected text: [${sanitize(snapshot.selectedText)}]`)
  } else if (snapshot.focusedSummary) {
    lines.push('', `The focused UI element is ${sanitize(snapshot.focusedSummary)}.`)
  }
  return lines.join('\n')
}

function bridgeTool(method: NativeActionMethod): string {
  return {
    click: 'click',
    performSecondaryAction: 'perform_secondary_action',
    scroll: 'scroll',
    drag: 'drag',
    typeText: 'type_text',
    pressKey: 'press_key',
    hotkey: 'hotkey',
    pasteText: 'paste_text',
    setValue: 'set_value'
  }[method]
}

function actionCapabilityKey(
  method: NativeActionMethod
): keyof ComputerProviderCapabilities['supports']['actions'] {
  const keys = {
    click: 'click',
    performSecondaryAction: 'performAction',
    scroll: 'scroll',
    drag: 'drag',
    typeText: 'typeText',
    pressKey: 'pressKey',
    hotkey: 'hotkey',
    pasteText: 'pasteText',
    setValue: 'setValue'
  } satisfies Record<NativeActionMethod, keyof ComputerProviderCapabilities['supports']['actions']>
  return keys[method]
}

function desktopActionMetadata(method: NativeActionMethod, targetWindowId: number | null) {
  const path =
    method === 'pasteText'
      ? ('clipboard' as const)
      : method === 'setValue' || method === 'performSecondaryAction'
        ? ('accessibility' as const)
        : ('synthetic' as const)
  return {
    path,
    actionName:
      method === 'hotkey'
        ? 'hotkey'
        : method === 'pasteText'
          ? 'paste'
          : method === 'setValue'
            ? 'setValue'
            : method === 'performSecondaryAction'
              ? 'performSecondaryAction'
              : null,
    fallbackReason: null,
    targetWindowId,
    verification:
      method === 'hotkey' || method === 'pasteText'
        ? {
            state: 'unverified' as const,
            reason:
              method === 'pasteText' ? ('clipboard_paste' as const) : ('synthetic_input' as const)
          }
        : undefined
  }
}

function normalizeBridgeApp(app: BridgeResponse['app'] | BridgeWindow['app'] | undefined) {
  if (!app) {
    throw new RuntimeClientError('accessibility_error', 'desktop provider returned no app')
  }
  return {
    name: app.name,
    bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
    pid: app.pid
  }
}

function elementParam(
  snapshot: BridgeSnapshot | null,
  index: number | undefined
): BridgeElement | undefined {
  if (index === undefined) {
    return undefined
  }
  const element = snapshot?.elements?.find((candidate) => candidate.index === index)
  if (!element) {
    throw new RuntimeClientError(
      'element_not_found',
      `element ${index} is not in the current cached snapshot; run get-app-state again and use a fresh element index`
    )
  }
  return element
}

function snapshotKeysForWindow(query: string, snapshot: BridgeSnapshot): string[] {
  return snapshot.windowId === null || snapshot.windowId === undefined
    ? []
    : [snapshotWindowKey(query, snapshot.windowId)]
}

function snapshotWindowKey(query: string, windowId: number): string {
  return `${query.toLowerCase()}#window:${windowId}`
}

function snapshotKeysForWindowIndex(query: string, params: Record<string, unknown>): string[] {
  const windowIndex = optionalNumberParam(params, 'windowIndex')
  return windowIndex === undefined ? [] : [snapshotWindowIndexKey(query, windowIndex)]
}

function snapshotWindowIndexKey(query: string, windowIndex: number): string {
  return `${query.toLowerCase()}#window-index:${windowIndex}`
}

function snapshotNamespace(params: Record<string, unknown>): string {
  const session = optionalStringParam(params, 'session')
  const worktree = optionalStringParam(params, 'worktree')
  return session ? `session:${session}` : worktree ? `worktree:${worktree}` : 'default'
}

function namespacedSnapshotKey(namespace: string, key: string): string {
  return `${namespace}:${key.toLowerCase()}`
}

function isExplicitSnapshotNamespace(namespace: string): boolean {
  return namespace !== 'default'
}

function mapBridgeError(message: string): RuntimeClientError {
  const text = message.trim() || 'desktop provider failed'
  if (/appNotFound|app not found/i.test(text)) {
    return new RuntimeClientError('app_not_found', text)
  }
  if (/appBlocked|app blocked/i.test(text)) {
    return new RuntimeClientError('app_blocked', text)
  }
  if (/unsupported capability|hotkey.*require|paste_text requires/i.test(text)) {
    return new RuntimeClientError('unsupported_capability', text)
  }
  if (/ModuleNotFoundError: No module named 'gi'|PyGObject|python3-gi/i.test(text)) {
    return new RuntimeClientError(
      'unsupported_capability',
      'Linux Computer Use requires python3-gi and AT-SPI packages. Install python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry.'
    )
  }
  if (/not a valid secondary action|action.*not supported/i.test(text)) {
    return new RuntimeClientError('action_not_supported', text)
  }
  if (/value is not settable|not settable/i.test(text)) {
    return new RuntimeClientError('value_not_settable', text)
  }
  if (/stale element|fresh element index/i.test(text)) {
    return new RuntimeClientError('element_not_found', text)
  }
  if (/windowStale|window stale/i.test(text)) {
    return new RuntimeClientError('window_stale', text)
  }
  if (/No top-level|No .*window|window/i.test(text)) {
    return new RuntimeClientError('window_not_found', text)
  }
  if (/permission|desktop session|DBUS|XDG_RUNTIME_DIR|AT-SPI/i.test(text)) {
    return new RuntimeClientError('permission_denied', text)
  }
  if (/element|element_index/i.test(text)) {
    return new RuntimeClientError('element_not_found', text)
  }
  return new RuntimeClientError('accessibility_error', text)
}

function requiredPlatform(): DesktopScriptPlatform {
  const platform = desktopScriptPlatform()
  if (!platform) {
    throw new RuntimeClientError('accessibility_error', 'desktop script provider is not available')
  }
  return platform
}

function requiredScriptPath(): string {
  const scriptPath = resolveDesktopScriptProviderPath()
  if (!scriptPath) {
    throw new RuntimeClientError(
      'accessibility_error',
      'desktop script provider script was not found'
    )
  }
  return scriptPath
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `missing ${key}`)
  }
  return value
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sanitize(value: string): string {
  return value.replaceAll('\n', ' ').replaceAll('\r', ' ')
}
