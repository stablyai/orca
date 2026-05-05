/* eslint-disable max-lines */
import { execFile, type ChildProcess } from 'child_process'
import { existsSync, accessSync, chmodSync, readFileSync, constants } from 'fs'
import { join } from 'path'
import { platform, arch } from 'os'
import { app } from 'electron'
import { CdpWsProxy } from './cdp-ws-proxy'
import { captureFullPageScreenshot } from './cdp-screenshot'
import type { BrowserManager } from './browser-manager'
import { BrowserError } from './cdp-bridge'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserCookie
} from '../../shared/runtime-types'

// Why: must exceed agent-browser's internal per-command timeouts (goto defaults to 30s,
// wait can be up to 60s). Using 90s ensures the bridge never kills a command before
// agent-browser's own timeout fires and returns a proper error.
const EXEC_TIMEOUT_MS = 90_000
const CONSECUTIVE_TIMEOUT_LIMIT = 3
const WAIT_PROCESS_TIMEOUT_GRACE_MS = 1_000

type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  // Why: track active interception patterns so they can be re-enabled after session restart
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Why: store the webContentsId so we can verify the tab is still alive at execution time,
  // not just at enqueue time. The queue delay can allow the tab to be destroyed in between.
  webContentsId: number
  activeProcess: ChildProcess | null
}

type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

type ResolvedBrowserCommandTarget = {
  browserPageId: string
  webContentsId: number
}

type AgentBrowserExecOptions = {
  envOverrides?: NodeJS.ProcessEnv
  timeoutMs?: number
  timeoutError?: BrowserError
}

function agentBrowserNativeName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform()}-${arch()}${ext}`
}

function resolveAgentBrowserBinary(): string {
  // Why: production builds copy the platform-specific binary into resources/
  // via electron-builder extraResources. Use Electron's resolved resourcesPath
  // instead of hand-rolling ../resources so packaged macOS builds keep working
  // on case-sensitive filesystems where Contents/Resources casing matters.
  const bundledResourcesPath =
    process.resourcesPath ??
    (process.platform === 'darwin'
      ? join(app.getPath('exe'), '..', '..', 'Resources')
      : join(app.getPath('exe'), '..', 'resources'))
  const bundled = join(bundledResourcesPath, agentBrowserNativeName())
  if (existsSync(bundled)) {
    return bundled
  }

  // Why: in dev mode, resolve directly to the native binary inside node_modules.
  // Use app.getAppPath() for a stable project root — __dirname is unreliable after
  // electron-vite bundles main process code into out/main/index.js.
  const nmBin = join(
    app.getAppPath(),
    'node_modules',
    'agent-browser',
    'bin',
    agentBrowserNativeName()
  )
  if (existsSync(nmBin)) {
    if (process.platform !== 'win32') {
      try {
        accessSync(nmBin, constants.X_OK)
      } catch {
        chmodSync(nmBin, 0o755)
      }
    }
    return nmBin
  }

  // Last resort: assume it's on PATH
  return 'agent-browser'
}

// Why: exec commands arrive as a single string (e.g. 'keyboard inserttext "hello world"').
// Naive split on whitespace breaks quoted arguments. This parser respects double and
// single quotes so the value arrives as a single argument without surrounding quotes.
function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

// Why: agent-browser returns generic error messages for stale/unknown refs.
// Map them to a specific code so agents can reliably detect and re-snapshot.
function classifyErrorCode(message: string): string {
  if (/unknown ref|ref not found|element not found: @e/i.test(message)) {
    return 'browser_stale_ref'
  }
  return 'browser_error'
}

function isTabClosedTransportError(message: string): boolean {
  return /session destroyed while command|session destroyed while commands|connection refused|cdp discovery methods failed|websocket connect failed/i.test(
    message
  )
}

function pageUnavailableMessageForSession(sessionName: string): string {
  const prefix = 'orca-tab-'
  const browserPageId = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null
  return browserPageId
    ? `Browser page ${browserPageId} is no longer available`
    : 'Browser tab is no longer available'
}

function translateResult(
  stdout: string
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  let parsed: { success?: boolean; data?: unknown; error?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      error: {
        code: 'browser_error',
        message: `Unexpected output from agent-browser: ${stdout.slice(0, 1000)}`
      }
    }
  }
  if (parsed.success) {
    return { ok: true, result: parsed.data }
  }
  const message = parsed.error ?? 'Unknown browser error'
  return {
    ok: false,
    error: {
      code: classifyErrorCode(message),
      message
    }
  }
}

export class AgentBrowserBridge {
  // Why: per-worktree active tab prevents one worktree's tab switch from
  // affecting another worktree's command targeting.
  private readonly activeWebContentsPerWorktree = new Map<string, number>()
  private activeWebContentsId: number | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly commandQueues = new Map<string, QueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  // Why: screenshot prep temporarily changes shared renderer visibility/focus
  // state. Per-session queues only serialize commands within one browser tab, so
  // concurrent screenshots on different tabs can otherwise interleave
  // ensureWebviewVisible()/restore and blank each other's capture.
  private screenshotTurn: Promise<void> = Promise.resolve()
  private readonly agentBrowserBin: string
  // Why: when a process swap destroys a session that had active intercept patterns,
  // store them here keyed by sessionName so the next ensureSession + first successful
  // command can restore them automatically.
  private readonly pendingInterceptRestore = new Map<string, string[]>()
  // Why: two concurrent CLI calls can both enter ensureSession before either creates
  // the session entry. This promise-based lock ensures only one creation proceeds.
  private readonly pendingSessionCreation = new Map<string, Promise<void>>()
  // Why: session destruction shells out to `agent-browser close`, which is async
  // and keyed by session name. Recreating the same session before that close
  // finishes can let the old teardown close the new daemon session.
  private readonly pendingSessionDestruction = new Map<string, Promise<void>>()
  private readonly cancelledProcesses = new WeakSet<ChildProcess>()

  constructor(private readonly browserManager: BrowserManager) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
  }

  // ── Tab tracking ──

  setActiveTab(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
  }

  private selectFallbackActiveWebContents(
    worktreeId: string,
    excludedWebContentsId?: number
  ): number | null {
    for (const [, wcId] of this.getRegisteredTabs(worktreeId)) {
      if (wcId === excludedWebContentsId) {
        continue
      }
      if (this.getWebContents(wcId)) {
        this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        return wcId
      }
    }
    this.activeWebContentsPerWorktree.delete(worktreeId)
    return null
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  getPageInfo(
    worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    try {
      const target = this.resolveCommandTarget(worktreeId, browserPageId)
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        return null
      }
      return {
        browserPageId: target.browserPageId,
        url: wc.getURL() ?? '',
        title: wc.getTitle() ?? ''
      }
    } catch {
      return null
    }
  }

  onTabChanged(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
  }

  async onTabClosed(webContentsId: number): Promise<void> {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    const owningWorktreeId = browserPageId
      ? this.browserManager.getWorktreeIdForTab(browserPageId)
      : undefined
    let nextWorktreeActiveWebContentsId: number | null = null
    if (
      owningWorktreeId &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === webContentsId
    ) {
      nextWorktreeActiveWebContentsId = this.selectFallbackActiveWebContents(
        owningWorktreeId,
        webContentsId
      )
    }
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = nextWorktreeActiveWebContentsId
    }
    if (browserPageId) {
      await this.destroySession(`orca-tab-${browserPageId}`)
    }
  }

  async onProcessSwap(
    browserPageId: string,
    newWebContentsId: number,
    previousWebContentsId?: number
  ): Promise<void> {
    // Why: Electron process swaps give same browserPageId but new webContentsId.
    // Old proxy's webContents is destroyed, so destroy session and let next command recreate.
    const sessionName = `orca-tab-${browserPageId}`
    const session = this.sessions.get(sessionName)
    const oldWebContentsId = previousWebContentsId ?? session?.webContentsId
    const owningWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    // Why: save active intercept patterns before destroying so they can be restored
    // on the new session after the next successful init command.
    if (session && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
    await this.destroySession(sessionName)
    if (oldWebContentsId != null && this.activeWebContentsId === oldWebContentsId) {
      this.activeWebContentsId = newWebContentsId
    }
    if (
      owningWorktreeId &&
      oldWebContentsId != null &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === oldWebContentsId
    ) {
      this.activeWebContentsPerWorktree.set(owningWorktreeId, newWebContentsId)
    }
  }

  // ── Worktree-scoped tab queries ──

  getRegisteredTabs(worktreeId?: string): Map<string, number> {
    const all = this.browserManager.getWebContentsIdByTabId()
    if (!worktreeId) {
      return all
    }

    const filtered = new Map<string, number>()
    for (const [tabId, wcId] of all) {
      if (this.browserManager.getWorktreeIdForTab(tabId) === worktreeId) {
        filtered.set(tabId, wcId)
      }
    }
    return filtered
  }

  // ── Tab management ──

  tabList(worktreeId?: string): BrowserTabListResult {
    const tabs = this.getRegisteredTabs(worktreeId)
    // Why: use per-worktree active tab for the "active" flag so tab-list is
    // consistent with what resolveActiveTab would pick for command routing.
    // Keep this read-only though: discovery commands must not mutate the
    // active-tab state that later bare commands rely on.
    let activeWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId
    const result: BrowserTabInfo[] = []
    let index = 0
    let firstLiveWcId: number | null = null
    for (const [tabId, wcId] of tabs) {
      const wc = this.getWebContents(wcId)
      if (!wc) {
        continue
      }
      if (firstLiveWcId === null) {
        firstLiveWcId = wcId
      }
      result.push({
        browserPageId: tabId,
        index: index++,
        url: wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId
      })
    }
    // Why: if no tab has been explicitly activated yet, surface the first live
    // tab as active in the listing without mutating bridge state. That keeps
    // `tab list` side-effect free while still showing users which tab a bare
    // command would select next.
    if (activeWcId == null && firstLiveWcId !== null) {
      activeWcId = firstLiveWcId
      if (result.length > 0) {
        result[0].active = true
      }
    }
    return { tabs: result }
  }

  // Why: tab switch must go through the command queue to prevent race conditions
  // with in-flight commands that target the previously active tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // Why: queue delay means the tab list can change between RPC arrival and
      // execution time. Recompute against live webContents here so we never
      // activate a tab index that disappeared while earlier commands were running.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      this.activeWebContentsId = wcId
      // Why: resolveActiveTab prefers the per-worktree map over the global when
      // worktreeId is provided. Without this update, subsequent commands would
      // still route to the previous tab despite tabSwitch reporting success.
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Why: `tab switch --page <id>` may omit --worktree because the page id is
      // already a stable target. We still need to update the owning worktree's
      // active-tab slot so later worktree-scoped commands follow the tab that was
      // just activated instead of the previously active one.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }

  // ── Core commands (typed) ──

  async snapshot(worktreeId?: string, browserPageId?: string): Promise<BrowserSnapshotResult> {
    // Why: snapshot creates fresh refs so it must bypass the stale-ref guard
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'snapshot'
      ])) as BrowserSnapshotResult
      return {
        ...result,
        browserPageId: target.browserPageId
      }
    })
  }

  async click(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['click', element])) as BrowserClickResult
    })
  }

  async dblclick(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['dblclick', element])) as BrowserClickResult
    })
  }

  async goto(url: string, worktreeId?: string, browserPageId?: string): Promise<BrowserGotoResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['goto', url])) as BrowserGotoResult
    })
  }

  async fill(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFillResult> {
    // Why: Input.insertText via Electron's debugger API does not deliver text to
    // focused inputs in webviews — this is a fundamental Electron limitation.
    // Agent-browser's fill and click also fail for the same reason.
    // Workaround: use agent-browser's focus to resolve the ref, then set the value
    // directly via JS and dispatch input/change events for React/framework compat.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      await this.execAgentBrowser(sessionName, ['focus', element])
      const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      await this.execAgentBrowser(sessionName, [
        'eval',
        `(() => { const el = document.activeElement; if (el) { const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (nativeSetter) { nativeSetter.call(el, '${escaped}'); } else { el.value = '${escaped}'; } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`
      ])
      return { filled: element } as BrowserFillResult
    })
  }

  async type(
    input: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTypeResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'keyboard',
        'type',
        input
      ])) as BrowserTypeResult
    })
  }

  async select(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'select',
        element,
        value
      ])) as BrowserSelectResult
    })
  }

  async scroll(
    direction: string,
    amount?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScrollResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['scroll', direction]
      if (amount != null) {
        args.push(String(amount))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserScrollResult
    })
  }

  async scrollIntoView(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['scrollintoview', element])
    })
  }

  async get(
    what: string,
    selector?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['get', what]
      if (selector) {
        args.push(selector)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async is(
    what: string,
    selector: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['is', what, selector])
    })
  }

  // ── Keyboard commands ──

  async keyboardInsertText(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['keyboard', 'inserttext', text])
    })
  }

  // ── Mouse commands ──

  async mouseMove(
    x: number,
    y: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['mouse', 'move', String(x), String(y)])
    })
  }

  async mouseDown(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'down']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseUp(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'up']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseWheel(
    dy: number,
    dx?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'wheel', String(dy)]
      if (dx != null) {
        args.push(String(dx))
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Find (semantic locators) ──

  async find(
    locator: string,
    value: string,
    action: string,
    text?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['find', locator, value, action]
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Set commands ──

  async setDevice(name: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'device', name])
    })
  }

  async setOffline(state?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'offline']
      if (state) {
        args.push(state)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async setHeaders(
    headersJson: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'headers', headersJson])
    })
  }

  async setCredentials(
    user: string,
    pass: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'credentials', user, pass])
    })
  }

  async setMedia(
    colorScheme?: string,
    reducedMotion?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'media']
      if (colorScheme) {
        args.push(colorScheme)
      }
      if (reducedMotion) {
        args.push(reducedMotion)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Clipboard commands ──

  async clipboardRead(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'read'])
    })
  }

  async clipboardWrite(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'write', text])
    })
  }

  // ── Dialog commands ──

  async dialogAccept(text?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['dialog', 'accept']
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async dialogDismiss(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['dialog', 'dismiss'])
    })
  }

  // ── Storage commands ──

  async storageLocalGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'get', key])
    })
  }

  async storageLocalSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'set', key, value])
    })
  }

  async storageLocalClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'clear'])
    })
  }

  async storageSessionGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'get', key])
    })
  }

  async storageSessionSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'set', key, value])
    })
  }

  async storageSessionClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'clear'])
    })
  }

  // ── Download command ──

  async download(
    selector: string,
    path: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['download', selector, path])
    })
  }

  // ── Highlight command ──

  async highlight(selector: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['highlight', selector])
    })
  }

  async back(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['back'])) as BrowserBackResult
    })
  }

  async forward(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['forward'])) as BrowserBackResult
    })
  }

  async reload(worktreeId?: string, browserPageId?: string): Promise<BrowserReloadResult> {
    // Why: reload can trigger a process swap in Electron (site-isolation), which
    // destroys the session mid-command. Use the webContents directly for reload
    // instead of going through agent-browser to avoid the session lifecycle issue.
    // Routed through enqueueCommand so it serializes with other in-flight commands.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      wc.reload()
      await new Promise<void>((resolve) => {
        const onFinish = (): void => {
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          resolve()
        }
        const onFail = (): void => {
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          resolve()
        }
        wc.on('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        setTimeout(onFinish, 10_000)
      })
      return { url: wc.getURL(), title: wc.getTitle() }
    })
  }

  async screenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why: agent-browser writes the screenshot to a temp file and returns
    // { "path": "/tmp/screenshot-xxx.png" }. We read the file and return base64.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return this.captureScreenshotCommand(sessionName, ['screenshot'], 300, format)
    })
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      return this.captureFullPageScreenshotCommand(
        sessionName,
        target.webContentsId,
        500,
        format === 'jpeg' ? 'jpeg' : 'png'
      )
    })
  }

  private readScreenshotFromResult(raw: unknown, format?: string): BrowserScreenshotResult {
    const parsed = raw as { path?: string } | undefined
    if (!parsed?.path) {
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    if (!existsSync(parsed.path)) {
      throw new BrowserError('browser_error', `Screenshot file not found: ${parsed.path}`)
    }
    const data = readFileSync(parsed.path).toString('base64')
    return { data, format: format === 'jpeg' ? 'jpeg' : 'png' } as BrowserScreenshotResult
  }

  private async captureScreenshotCommand(
    sessionName: string,
    commandArgs: string[],
    settleMs: number,
    format?: string
  ): Promise<BrowserScreenshotResult> {
    return this.withSerializedScreenshotAccess(async () => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.ensureWebviewVisible(session.webContentsId)
        : () => {}
      try {
        // Why: after focusing the window and unhiding the webview, the compositor
        // needs a short settle period to produce a painted frame. Waiting inside
        // the global screenshot lock prevents another tab from stealing visible
        // state before the current capture actually hits CDP.
        await new Promise((r) => setTimeout(r, settleMs))
        const raw = await this.execAgentBrowser(sessionName, commandArgs)
        return this.readScreenshotFromResult(raw, format)
      } finally {
        restore()
      }
    })
  }

  private async captureFullPageScreenshotCommand(
    sessionName: string,
    webContentsId: number,
    settleMs: number,
    format: 'png' | 'jpeg'
  ): Promise<BrowserScreenshotResult> {
    return this.withSerializedScreenshotAccess(async () => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.ensureWebviewVisible(session.webContentsId)
        : () => {}
      try {
        // Why: full-page capture still depends on the guest compositor producing
        // a fresh frame. Wait after activating the target webview so the direct
        // CDP capture sees the live page instead of a stale surface.
        await new Promise((r) => setTimeout(r, settleMs))
        const wc = this.getWebContents(webContentsId)
        if (!wc) {
          throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
        }
        return await captureFullPageScreenshot(wc, format)
      } catch (error) {
        throw new BrowserError('browser_error', (error as Error).message)
      } finally {
        restore()
      }
    })
  }

  private async withSerializedScreenshotAccess<T>(execute: () => Promise<T>): Promise<T> {
    const previousTurn = this.screenshotTurn.catch(() => {})
    let releaseTurn!: () => void
    this.screenshotTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    await previousTurn
    try {
      return await execute()
    } finally {
      releaseTurn()
    }
  }

  async evaluate(
    expression: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserEvalResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['eval', expression])) as BrowserEvalResult
    })
  }

  async hover(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserHoverResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['hover', element])) as BrowserHoverResult
    })
  }

  async drag(
    from: string,
    to: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserDragResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['drag', from, to])) as BrowserDragResult
    })
  }

  async upload(
    element: string,
    filePaths: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserUploadResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'upload',
        element,
        ...filePaths
      ])) as BrowserUploadResult
    })
  }

  async wait(
    options?: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    },
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserWaitResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['wait']
      const hasCondition =
        !!options?.selector || !!options?.text || !!options?.url || !!options?.load || !!options?.fn
      if (options?.selector) {
        args.push(options.selector)
      } else if (options?.timeout != null && !hasCondition) {
        args.push(String(options.timeout))
      }
      if (options?.text) {
        args.push('--text', options.text)
      }
      if (options?.url) {
        args.push('--url', options.url)
      }
      if (options?.load) {
        args.push('--load', options.load)
      }
      if (options?.fn) {
        args.push('--fn', options.fn)
      }
      const normalizedState = options?.state === 'visible' ? undefined : options?.state
      if (normalizedState) {
        args.push('--state', normalizedState)
      }
      // Why: agent-browser's selector wait surface does not support `--state visible`
      // or a documented per-command `--timeout`. Orca normalizes "visible" back
      // to the default selector wait semantics and enforces the requested timeout
      // at the bridge layer so missing selectors fail as browser_timeout instead
      // of hanging until the generic runtime RPC timeout fires.
      return (await this.execAgentBrowser(sessionName, args, {
        timeoutMs:
          options?.timeout != null && hasCondition
            ? options.timeout + WAIT_PROCESS_TIMEOUT_GRACE_MS
            : undefined,
        timeoutError:
          options?.timeout != null && hasCondition
            ? new BrowserError(
                'browser_timeout',
                `Timed out waiting for browser condition after ${options.timeout}ms.`
              )
            : undefined
      })) as BrowserWaitResult
    })
  }

  async check(
    element: string,
    checked: boolean,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCheckResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = checked ? ['check', element] : ['uncheck', element]
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCheckResult
    })
  }

  async focus(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFocusResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['focus', element])) as BrowserFocusResult
    })
  }

  async clear(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClearResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser has no clear command — use fill with empty string
      return (await this.execAgentBrowser(sessionName, ['fill', element, ''])) as BrowserClearResult
    })
  }

  async selectAll(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectAllResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser has no select-all command — implement as focus + Ctrl+A
      await this.execAgentBrowser(sessionName, ['focus', element])
      return (await this.execAgentBrowser(sessionName, [
        'press',
        'Control+a'
      ])) as BrowserSelectAllResult
    })
  }

  async keypress(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserKeypressResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['press', key])) as BrowserKeypressResult
    })
  }

  async pdf(worktreeId?: string, browserPageId?: string): Promise<BrowserPdfResult> {
    // Why: agent-browser's pdf command via CDP Page.printToPDF hangs in Electron
    // webviews. Use Electron's native webContents.printToPDF() which is reliable.
    // Routed through enqueueCommand so it serializes with other in-flight commands.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      const buffer = await wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      })
      return { data: buffer.toString('base64') }
    })
  }

  // ── Cookie commands ──

  async cookieGet(
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieGetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'cookies',
        'get'
      ])) as BrowserCookieGetResult
    })
  }

  async cookieSet(
    cookie: Partial<BrowserCookie>,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieSetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['cookies', 'set', cookie.name ?? '', cookie.value ?? '']
      if (cookie.domain) {
        args.push('--domain', cookie.domain)
      }
      if (cookie.path) {
        args.push('--path', cookie.path)
      }
      if (cookie.secure) {
        args.push('--secure')
      }
      if (cookie.httpOnly) {
        args.push('--httpOnly')
      }
      if (cookie.sameSite) {
        args.push('--sameSite', cookie.sameSite)
      }
      if (cookie.expires != null) {
        args.push('--expires', String(cookie.expires))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieSetResult
    })
  }

  async cookieDelete(
    name?: string,
    domain?: string,
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['cookies', 'clear']
      if (name) {
        args.push('--name', name)
      }
      if (domain) {
        args.push('--domain', domain)
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieDeleteResult
    })
  }

  // ── Viewport / emulation commands ──

  async setViewport(
    width: number,
    height: number,
    scale = 1,
    mobile = false,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserViewportResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
      }
      const dbg = wc.debugger
      if (!dbg.isAttached()) {
        throw new BrowserError('browser_error', 'Debugger not attached')
      }

      // Why: agent-browser only supports width/height/scale for `set viewport`;
      // it has no `mobile` flag. Orca's CLI exposes `--mobile`, so apply the
      // emulation directly through CDP to keep the public CLI contract honest.
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      })

      return {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      }
    })
  }

  async setGeolocation(
    lat: number,
    lon: number,
    _accuracy?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserGeolocationResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'set',
        'geo',
        String(lat),
        String(lon)
      ])) as BrowserGeolocationResult
    })
  }

  // ── Network interception commands ──

  async interceptEnable(
    patterns?: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptEnableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser uses "network route <url>" to intercept. Route each pattern individually.
      const urlPattern = patterns?.[0] ?? '**/*'
      const args = ['network', 'route', urlPattern]
      const result = (await this.execAgentBrowser(
        sessionName,
        args
      )) as BrowserInterceptEnableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = patterns ?? ['*']
      }
      return result
    })
  }

  async interceptDisable(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptDisableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'unroute'
      ])) as BrowserInterceptDisableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = []
      }
      return result
    })
  }

  async interceptList(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<{ requests: unknown[] }> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['network', 'requests'])) as {
        requests: unknown[]
      }
    })
  }

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request
  // interception decisions. Currently agent-browser only operates on URL pattern-level
  // routing, not individual request IDs, so the RPC/CLI interface doesn't map cleanly.

  // ── Capture commands ──

  async captureStart(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStartResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'start'
      ])) as BrowserCaptureStartResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = true
      }
      return result
    })
  }

  async captureStop(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStopResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'stop'
      ])) as BrowserCaptureStopResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = false
      }
      return result
    })
  }

  async consoleLog(
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserConsoleResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['console'])) as BrowserConsoleResult
    })
  }

  async networkLog(
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserNetworkLogResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'requests'
      ])) as BrowserNetworkLogResult
    })
  }

  // ── Generic passthrough ──

  async exec(command: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: strip --cdp and --session from raw command to prevent session/target injection
      const sanitized = command
        .replace(/--cdp\s+\S+/g, '')
        .replace(/--session\s+\S+/g, '')
        .trim()
      const args = parseShellArgs(sanitized)
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Session lifecycle ──

  async destroyAllSessions(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const sessionName of this.sessions.keys()) {
      promises.push(this.destroySession(sessionName))
    }
    await Promise.allSettled(promises)
  }

  // ── Internal ──

  private async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, undefined, async (sessionName) =>
      execute(sessionName)
    )
  }

  private async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>
  ): Promise<T> {
    const target = this.resolveCommandTarget(worktreeId, browserPageId)
    const sessionName = `orca-tab-${target.browserPageId}`

    await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: (() => execute(sessionName, target)) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  private async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    this.processingQueues.delete(sessionName)
  }

  getActivePageId(worktreeId?: string, browserPageId?: string): string | null {
    try {
      return this.resolveCommandTarget(worktreeId, browserPageId).browserPageId
    } catch {
      return null
    }
  }

  private resolveCommandTarget(
    worktreeId?: string,
    browserPageId?: string
  ): ResolvedBrowserCommandTarget {
    if (!browserPageId) {
      return this.resolveActiveTab(worktreeId)
    }

    const tabs = this.getRegisteredTabs(worktreeId)
    const webContentsId = tabs.get(browserPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }

    if (!this.getWebContents(webContentsId)) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} is no longer available`
      )
    }

    return { browserPageId, webContentsId }
  }

  private resolveActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    const tabs = this.getRegisteredTabs(worktreeId)

    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

    // Why: prefer per-worktree active tab to prevent cross-worktree interference.
    // Fall back to global activeWebContentsId for callers that don't pass worktreeId.
    const preferredWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId

    if (preferredWcId != null) {
      for (const [tabId, wcId] of tabs) {
        if (wcId === preferredWcId && this.getWebContents(wcId)) {
          return { browserPageId: tabId, webContentsId: wcId }
        }
      }
    }

    // Why: persisted store state can leave ghost tabs whose webContents no longer exist.
    // Skip those and pick the first live tab. Also activate it so tabList and
    // subsequent resolveActiveTab calls are consistent without requiring an
    // explicit tab switch after app startup.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        this.activeWebContentsId = wcId
        if (worktreeId) {
          this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        }
        return { browserPageId: tabId, webContentsId: wcId }
      }
    }

    throw new BrowserError(
      'browser_no_tab',
      'No live browser tab available — all registered tabs have been destroyed'
    )
  }

  private async ensureSession(
    sessionName: string,
    browserPageId: string,
    webContentsId: number
  ): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
    }

    if (this.sessions.has(sessionName)) {
      return
    }

    // Why: two concurrent CLI calls can both reach here before either finishes
    // creating the session. Without this lock, both would create proxies and the
    // second would overwrite the first, leaking the first proxy's server/debugger.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        // Why: the renderer can unregister/destroy a webview between target
        // resolution and session creation. Preserve the explicit page identity
        // so callers get the same error shape as a settled closed tab.
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${browserPageId} is no longer available`
        )
      }

      // Why: agent-browser's daemon persists session state (including the CDP port)
      // across Orca restarts. A stale session ignores --cdp (already initialized) and
      // connects to the dead port. Must await close so the daemon forgets the session
      // before we pass --cdp with the new port.
      await new Promise<void>((resolve) => {
        execFile(this.agentBrowserBin, ['--session', sessionName, 'close'], { timeout: 3000 }, () =>
          resolve()
        )
      })

      const proxy = new CdpWsProxy(wc)
      const cdpEndpoint = await proxy.start()

      this.sessions.set(sessionName, {
        proxy,
        cdpEndpoint,
        initialized: false,
        consecutiveTimeouts: 0,
        activeInterceptPatterns: [],
        activeCapture: false,
        webContentsId,
        activeProcess: null
      })
    }

    const promise = createSession()
    this.pendingSessionCreation.set(sessionName, promise)
    try {
      await promise
    } finally {
      this.pendingSessionCreation.delete(sessionName)
    }
  }

  private async destroySession(sessionName: string): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
      return
    }

    const session = this.sessions.get(sessionName)
    if (!session) {
      return
    }

    this.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)

    // Why: queued commands would hang forever if we just delete the queue —
    // their promises would never resolve or reject. Drain and reject them.
    const queue = this.commandQueues.get(sessionName)
    this.commandQueues.delete(sessionName)
    this.processingQueues.delete(sessionName)
    if (queue) {
      const err = new BrowserError(
        'browser_tab_closed',
        'Tab was closed while commands were queued'
      )
      for (const cmd of queue) {
        cmd.reject(err)
      }
      queue.length = 0
    }

    if (session.activeProcess) {
      // Why: queued command rejection is not enough when a daemon command is
      // already running. Kill the active process so callers do not wait for the
      // generic exec timeout after the session/tab has already been destroyed.
      this.cancelledProcesses.add(session.activeProcess)
      try {
        session.activeProcess.kill()
      } catch {
        // Process may already be exiting.
      }
      session.activeProcess = null
    }

    const destroy = (async (): Promise<void> => {
      try {
        // Why: each browser tab uses its own named agent-browser session. Closing
        // without --session only tears down the default session and leaves the tab
        // session's daemon process running.
        await this.runAgentBrowserRaw(sessionName, ['--session', sessionName, 'close'])
      } catch {
        // Session may already be dead
      }

      await session.proxy.stop()
    })()
    this.pendingSessionDestruction.set(sessionName, destroy)
    try {
      await destroy
    } finally {
      this.pendingSessionDestruction.delete(sessionName)
    }
  }

  private async execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      // Why: queued commands can reach execution after a concurrent tab close
      // deletes the session. Surface this as a tab lifecycle error, not an
      // opaque internal bridge failure.
      throw this.createPageUnavailableError(sessionName)
    }

    // Why: between enqueue time and execution time (queue delay), the webContents
    // could be destroyed. Check here to give a clear error instead of letting the
    // proxy fail with cryptic Electron debugger errors.
    if (!this.getWebContents(session.webContentsId)) {
      throw this.createPageUnavailableError(sessionName)
    }

    const args = ['--session', sessionName]
    const managesInterceptRoutes =
      commandArgs[0] === 'network' && (commandArgs[1] === 'route' || commandArgs[1] === 'unroute')

    // Why: --cdp is session-initialization only — first command needs it, subsequent don't.
    // Pass as port number (not ws:// URL) so agent-browser hits the proxy's HTTP /json
    // endpoint for target discovery. The proxy only exposes the webview, preventing
    // agent-browser from picking the host renderer page.
    const needsInit = !session.initialized
    if (needsInit) {
      const port = session.proxy.getPort()
      args.push('--cdp', String(port))
    }

    args.push(...commandArgs, '--json')

    const stdout = await this.runAgentBrowserRaw(sessionName, args, execOptions)
    const translated = translateResult(stdout)

    if (!translated.ok) {
      throw this.createCommandError(
        sessionName,
        translated.error.message,
        translated.error.code,
        session.webContentsId
      )
    }

    // Why: only mark initialized after a successful command — if the first --cdp
    // connection fails, the next attempt should retry with --cdp.
    if (needsInit) {
      session.initialized = true

      // Why: after a process swap, intercept patterns are lost because the session
      // was destroyed and recreated. Restore them now that the new session is live,
      // unless the caller's first command explicitly reconfigured routing.
      const pendingPatterns = managesInterceptRoutes
        ? undefined
        : this.pendingInterceptRestore.get(sessionName)
      if (pendingPatterns && pendingPatterns.length > 0) {
        this.pendingInterceptRestore.delete(sessionName)
        try {
          const urlPattern = pendingPatterns[0] ?? '**/*'
          await this.runAgentBrowserRaw(sessionName, [
            '--session',
            sessionName,
            'network',
            'route',
            urlPattern,
            '--json'
          ])
          session.activeInterceptPatterns = pendingPatterns
        } catch {
          // Why: intercept restore is best-effort — don't fail the user's command
          // if the new page doesn't support the same interception setup.
        }
      }
    }

    return translated.result
  }

  private createPageUnavailableError(sessionName: string): BrowserError {
    return new BrowserError('browser_tab_not_found', pageUnavailableMessageForSession(sessionName))
  }

  private createCommandError(
    sessionName: string,
    message: string,
    fallbackCode: string,
    webContentsId?: number
  ): BrowserError {
    // Why: CDP "connection refused" can also mean a real proxy failure. Only
    // convert it to a closed-page error when bridge state confirms the target is gone.
    if (
      fallbackCode === 'browser_error' &&
      isTabClosedTransportError(message) &&
      this.isSessionTargetClosed(sessionName, webContentsId)
    ) {
      return this.createPageUnavailableError(sessionName)
    }
    return new BrowserError(fallbackCode, message)
  }

  private isSessionTargetClosed(sessionName: string, webContentsId?: number): boolean {
    const session = this.sessions.get(sessionName)
    if (!session) {
      return true
    }
    const targetWebContentsId = webContentsId ?? session.webContentsId
    return !this.getWebContents(targetWebContentsId)
  }

  private runAgentBrowserRaw(
    sessionName: string,
    args: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const session = this.sessions.get(sessionName)
      let child: ChildProcess | null = null
      child = execFile(
        this.agentBrowserBin,
        args,
        // Why: screenshots return large base64 strings that exceed Node's default
        // 1MB maxBuffer, causing ENOBUFS and a timeout-like failure.
        {
          timeout: execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024,
          env: execOptions?.envOverrides
            ? { ...process.env, ...execOptions.envOverrides }
            : process.env
        },
        (error, stdout, stderr) => {
          if (session && session.activeProcess === child) {
            session.activeProcess = null
          }
          if (child && this.cancelledProcesses.has(child)) {
            this.cancelledProcesses.delete(child)
            reject(
              new BrowserError('browser_tab_closed', 'Tab was closed while command was running')
            )
            return
          }

          const liveSession = this.sessions.get(sessionName)

          if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            if (execOptions?.timeoutError) {
              reject(execOptions.timeoutError)
              return
            }
            if (liveSession) {
              liveSession.consecutiveTimeouts++
              if (liveSession.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                // Why: 3 consecutive timeouts means the daemon is likely stuck — destroy and recreate
                this.destroySession(sessionName)
              }
            }
            reject(new BrowserError('browser_error', 'Browser command timed out'))
            return
          }

          if (liveSession) {
            liveSession.consecutiveTimeouts = 0
          }

          if (error) {
            // Why: agent-browser exits non-zero for command failures (e.g. clipboard
            // NotAllowedError) but still writes structured JSON to stdout. Parse it
            // so callers get the real error message instead of generic "Command failed".
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout)
                if (parsed.error) {
                  const code = classifyErrorCode(parsed.error)
                  reject(
                    this.createCommandError(sessionName, parsed.error, code, session?.webContentsId)
                  )
                  return
                }
              } catch {
                // stdout not valid JSON — fall through to stderr/error.message
              }
            }
            const message = stderr || error.message
            const code = classifyErrorCode(message)
            reject(this.createCommandError(sessionName, message, code, session?.webContentsId))
            return
          }

          resolve(stdout)
        }
      )
      if (session) {
        session.activeProcess = child
      }
    })
  }

  private resolveTabIdSafe(webContentsId: number): string | null {
    const tabs = this.browserManager.getWebContentsIdByTabId()
    for (const [tabId, wcId] of tabs) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    return null
  }

  private getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      return webContents.fromId(webContentsId) ?? null
    } catch {
      return null
    }
  }
}
