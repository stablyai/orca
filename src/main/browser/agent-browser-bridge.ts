/* eslint-disable max-lines */
import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, accessSync, chmodSync, readFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import { platform, arch } from 'node:os'
import { app, type WebContents } from 'electron'
import { CdpWsProxy } from './cdp-ws-proxy'
import { captureFullPageScreenshot } from './cdp-screenshot'
import { acquireElectronDebugger } from './electron-debugger-lease'
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
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { iterateBrowserTextInsertionChunks } from './browser-text-insertion'

// Why: must exceed agent-browser's internal timeouts (goto 30s, wait 60s) so the bridge never kills a command before its own timeout fires.
const EXEC_TIMEOUT_MS = 90_000
const CONSECUTIVE_TIMEOUT_LIMIT = 3
const WAIT_PROCESS_TIMEOUT_GRACE_MS = 1_000
const STALE_SESSION_CLOSE_TIMEOUT_MS = 3_000
const EMBEDDED_NAVIGATION_TIMEOUT_MS = 30_000
export const AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES = 8 * 1024
export const AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES = AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES

type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  // Why: track active interception patterns so they can be re-enabled after session restart
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Why: verify the tab is alive at execution time, not just enqueue time — queue delay can destroy it in between.
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

export type BrowserMouseModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

function focusedValueSetExpression(
  valueExpression: string,
  options?: { append?: boolean; dispatchEvents?: boolean }
): string {
  const nextValue = options?.append
    ? ["String(target.value ?? '') + ", valueExpression].join('')
    : valueExpression
  const dispatchEvents = options?.dispatchEvents
    ? " target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));"
    : ''
  return [
    '(() => { const el = document.activeElement; if (el) {',
    // Why: ARIA spinbutton wrappers can hold focus while a contained or controlled input owns the value.
    " const editableSelector = \"input:not([type='hidden']):not([type='button']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='image']):not([type='reset']):not([type='submit']), textarea\";",
    " const isEditable = (node) => !!node && (node.matches?.(editableSelector) ?? (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && !/^(hidden|button|checkbox|radio|file|image|reset|submit)$/i.test(node.getAttribute?.('type') ?? ''))));",
    ' const findEditable = (root) => root?.querySelector?.(editableSelector) ?? null;',
    ' let target = el;',
    " if (!isEditable(target) && target.getAttribute?.('role') === 'spinbutton') {",
    "   const controls = target.getAttribute('aria-controls');",
    '   if (controls) { for (const id of controls.split(/\\s+/)) { if (!id) continue; const controlled = document.getElementById(id); if (isEditable(controlled)) { target = controlled; break; } const descendant = findEditable(controlled); if (descendant) { target = descendant; break; } } }',
    '   if (target === el) { const descendant = findEditable(target); if (descendant) target = descendant; }',
    ' }',
    " const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;",
    ' const nextValue = ',
    nextValue,
    '; if (nativeSetter) { nativeSetter.call(target, nextValue); } else { target.value = nextValue; }',
    dispatchEvents,
    ' } })()'
  ].join('')
}

// Why: rich editors reconcile only real browser edit transactions; a direct-DOM fallback can leave their model stale.
function focusedRichTextEditExpression(
  valueExpression: string,
  options?: { selectAll?: boolean }
): string {
  const selectAll = options?.selectAll ? 'true' : 'false'
  return [
    '(() => {',
    ' const target = document.activeElement;',
    ' const value = ',
    valueExpression,
    ';',
    ` const selectAll = ${selectAll};`,
    " const isEditable = target?.isContentEditable === true || /^(|true|plaintext-only)$/i.test(target?.getAttribute?.('contenteditable') ?? 'false');",
    " if (!target || target === document.body || !isEditable) { throw new Error('Focused rich-text target is unavailable'); }",
    ' if (selectAll) {',
    "   if (typeof window.getSelection !== 'function') { throw new Error('Rich-text selection is unavailable'); }",
    '   const selection = window.getSelection();',
    "   if (!selection) { throw new Error('Rich-text selection is unavailable'); }",
    '   selection.selectAllChildren(target);',
    ' }',
    " const editCommand = selectAll && value.length === 0 ? 'delete' : 'insertText';",
    ' let edited = false;',
    ' try {',
    '   edited = document.execCommand(editCommand, false, value) === true;',
    ' } catch { edited = false; }',
    " if (!edited) { throw new Error('Browser rich-text editing command failed'); }",
    ' })()'
  ].join('')
}

function isExplicitContentEditableResult(result: unknown): boolean {
  const value =
    result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined
  return typeof value === 'string' && /^(|true|plaintext-only)$/i.test(value)
}

type AgentBrowserExecOptions = {
  envOverrides?: NodeJS.ProcessEnv
  timeoutMs?: number
  timeoutError?: BrowserError
  stdinText?: string
}

type EnqueueTargetedCommandOptions = {
  ensureSession?: boolean
  ensureVisible?: boolean
  // Why: text-mutating commands must never fall back to the global tab (may be a worktree the user is viewing).
  requireScopedTarget?: boolean
}

type AgentBrowserBridgeOptions = {
  onTabsChanged?: (worktreeId?: string) => void
}

function agentBrowserNativeName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform()}-${arch()}${ext}`
}

function resolveAgentBrowserBinary(): string {
  // Why: use Electron's resourcesPath (not hand-rolled ../resources) so packaged macOS case-sensitive builds resolve the binary.
  const bundledResourcesPath =
    process.resourcesPath ??
    (process.platform === 'darwin'
      ? join(app.getPath('exe'), '..', '..', 'Resources')
      : join(app.getPath('exe'), '..', 'resources'))
  const bundled = join(bundledResourcesPath, agentBrowserNativeName())
  if (existsSync(bundled)) {
    return bundled
  }

  // Why: dev mode — resolve from node_modules via app.getAppPath(); __dirname is unreliable after electron-vite bundling.
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

// Why: exec commands arrive as one string; split on whitespace but respect quotes so quoted args stay intact.
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

function stripAgentBrowserTargetArgs(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--cdp' || arg === '--session') {
      index++
      continue
    }
    if (arg.startsWith('--cdp=') || arg.startsWith('--session=')) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

// Why: agent-browser returns generic errors for stale/unknown refs; map to a specific code so agents can detect and re-snapshot.
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

type CdpMouseButton = 'left' | 'middle' | 'right'

type BrowserClickPoint = {
  x: number
  y: number
  adjusted: boolean
  handled: boolean
}

function normalizeCdpMouseButton(button?: string): CdpMouseButton {
  return button === 'middle' || button === 'right' ? button : 'left'
}

function cdpMouseButtonMask(button: CdpMouseButton): number {
  if (button === 'right') {
    return 2
  }
  if (button === 'middle') {
    return 4
  }
  return 1
}

function cdpMouseModifierMask(modifiers: BrowserMouseModifier[] | undefined): number {
  if (!modifiers || modifiers.length === 0) {
    return 0
  }
  let mask = 0
  for (const modifier of modifiers) {
    if (modifier === 'alt') {
      mask |= 1
    } else if (modifier === 'ctrl') {
      mask |= 2
    } else if (modifier === 'cmd') {
      mask |= 4
    } else if (modifier === 'shift') {
      mask |= 8
    }
  }
  return mask
}

function readClickPoint(value: unknown, fallback: BrowserClickPoint): BrowserClickPoint {
  const point = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const x = point?.x
  const y = point?.y
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    return fallback
  }
  return { x, y, adjusted: point?.adjusted === true, handled: point?.handled === true }
}

function mobileTouchClickExpression(
  x: number,
  y: number,
  radius: number,
  allowDomActivation: boolean
): string {
  return `(() => {
    const inputX = ${JSON.stringify(x)};
    const inputY = ${JSON.stringify(y)};
    const radius = ${JSON.stringify(radius)};
    const allowDomActivation = ${JSON.stringify(allowDomActivation)};
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      'label',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const isUsable = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const dispatchClick = (target, clickX, clickY) => {
      try {
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
      } catch {
        try { target.focus(); } catch {}
      }
      if (typeof target.click === 'function') {
        target.click();
        return true;
      }
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clickX,
        clientY: clickY,
        screenX: clickX,
        screenY: clickY,
        button: 0,
        buttons: 1
      };
      try {
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'touch', pointerId: 1 }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'touch', pointerId: 1 }));
        }
      } catch {}
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      return true;
    };
    const clickableFor = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (node.matches(selector)) return node;
        if (window.getComputedStyle(node).cursor === 'pointer') return node;
      }
      return null;
    };
    const offsets = [[0, 0]];
    for (const distance of [radius * 0.45, radius, radius * 1.35]) {
      for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI,
        Math.PI * 5 / 4, Math.PI * 3 / 2, Math.PI * 7 / 4]) {
        offsets.push([Math.cos(angle) * distance, Math.sin(angle) * distance]);
      }
    }
    let best = null;
    for (const [dx, dy] of offsets) {
      const px = inputX + dx;
      const py = inputY + dy;
      if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
      for (const el of document.elementsFromPoint(px, py)) {
        const target = clickableFor(el);
        if (!target || !isUsable(target)) continue;
        const rect = target.getBoundingClientRect();
        const clickX = clamp(inputX, rect.left + 1, rect.right - 1);
        const clickY = clamp(inputY, rect.top + 1, rect.bottom - 1);
        const score = Math.hypot(clickX - inputX, clickY - inputY) + Math.hypot(dx, dy) * 0.25;
        if (!best || score < best.score) best = { score, x: clickX, y: clickY, target };
        break;
      }
    }
    if (best && allowDomActivation && dispatchClick(best.target, best.x, best.y)) {
      return { x: best.x, y: best.y, adjusted: true, handled: true };
    }
    if (best) {
      return { x: best.x, y: best.y, adjusted: true, handled: false };
    }
    return { x: inputX, y: inputY, adjusted: false, handled: false };
  })()`
}

async function resolveMobileTouchClickPoint(
  dbg: WebContents['debugger'],
  x: number,
  y: number,
  radius: number | undefined,
  allowDomActivation: boolean
): Promise<BrowserClickPoint> {
  const fallback = { x, y, adjusted: false, handled: false }
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return fallback
  }
  try {
    const result = await dbg.sendCommand('Runtime.evaluate', {
      expression: mobileTouchClickExpression(x, y, radius, allowDomActivation),
      returnByValue: true,
      silent: true
    })
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    const evaluated = raw?.result && typeof raw.result === 'object' ? raw.result : null
    return readClickPoint((evaluated as Record<string, unknown> | null)?.value, fallback)
  } catch {
    return fallback
  }
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
  // Why: per-worktree active tab so one worktree's tab switch can't affect another's command targeting.
  private readonly activeWebContentsPerWorktree = new Map<string, number>()
  private activeWebContentsId: number | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly commandQueues = new Map<string, QueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  // Why: screenshot prep mutates shared paintability across tabs; serialize globally so concurrent captures don't blank each other.
  private screenshotTurn: Promise<void> = Promise.resolve()
  private readonly agentBrowserBin: string
  // Why: stash intercept patterns from a swap-destroyed session, keyed by name, so the next session restores them.
  private readonly pendingInterceptRestore = new Map<string, string[]>()
  // Why: promise-lock so two concurrent ensureSession calls don't both create the session entry.
  private readonly pendingSessionCreation = new Map<string, Promise<void>>()
  // Why: `agent-browser close` is async, keyed by session name — recreating before it finishes lets the old teardown close the new session.
  private readonly pendingSessionDestruction = new Map<string, Promise<void>>()
  private readonly cancelledProcesses = new WeakSet<ChildProcess>()

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: AgentBrowserBridgeOptions = {}
  ) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
  }

  // ── Tab tracking ──

  setActiveTab(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
    this.options.onTabsChanged?.(worktreeId)
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
    this.options.onTabsChanged?.(worktreeId)
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
      const sessionName = `orca-tab-${browserPageId}`
      await this.destroySession(sessionName)
      this.pendingInterceptRestore.delete(sessionName)
    }
    this.options.onTabsChanged?.(owningWorktreeId)
  }

  async onProcessSwap(
    browserPageId: string,
    newWebContentsId: number,
    previousWebContentsId?: number
  ): Promise<void> {
    // Why: an Electron process swap keeps browserPageId but gives a new webContentsId — destroy the session so the next command recreates it.
    const sessionName = `orca-tab-${browserPageId}`
    const session = this.sessions.get(sessionName)
    const oldWebContentsId = previousWebContentsId ?? session?.webContentsId
    const owningWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    // Why: save intercept patterns before destroy so the new session can restore them after init.
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
    this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
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
    // Why: use the per-worktree active tab so listing matches command routing, but read-only — discovery must not mutate active-tab state.
    let activeWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId
    const result: BrowserTabInfo[] = []
    let index = 0
    let firstLiveWcId: number | null = null
    for (const [tabId, wcId] of tabs) {
      const wc = this.getWebContents(wcId)
      if (!wc) {
        this.browserManager.unregisterGuest(tabId)
        continue
      }
      if (firstLiveWcId === null) {
        firstLiveWcId = wcId
      }
      const loadError = this.browserManager.getBrowserPageLoadError(tabId)
      const certificateFailure = this.browserManager.getBrowserPageCertificateFailure(tabId)
      result.push({
        browserPageId: tabId,
        index: index++,
        // Why: failed WebContents report chrome-error://, not the address the user asked to load.
        url: loadError?.validatedUrl ?? wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId,
        loadError,
        certificateFailure
      })
    }
    // Why: with no active tab yet, show the first live tab as active without mutating state — keeps `tab list` side-effect free.
    if (activeWcId == null && firstLiveWcId !== null) {
      activeWcId = firstLiveWcId
      if (result.length > 0) {
        result[0].active = true
      }
    }
    return { tabs: result }
  }

  // Why: route tab switch through the command queue so it can't race in-flight commands targeting the old tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // Why: queue delay can change the tab list before execution — recompute against live webContents so no vanished index is activated.
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
      // Why: resolveActiveTab prefers the per-worktree map, so update it or later commands keep routing to the old tab.
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Why: `tab switch --page` may omit --worktree, so still update the owning worktree's active slot for later scoped commands.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        const navigationUrl = normalizeBrowserNavigationUrl(url)
        if (!navigationUrl) {
          throw new BrowserError('invalid_argument', `Unsupported browser URL: ${url}`)
        }
        let navigationTimeout: ReturnType<typeof setTimeout> | null = null
        try {
          await Promise.race([
            wc.loadURL(navigationUrl),
            new Promise<never>((_resolve, reject) => {
              navigationTimeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`
                    )
                  ),
                EMBEDDED_NAVIGATION_TIMEOUT_MS
              )
              navigationTimeout.unref?.()
            })
          ])
        } catch (error) {
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(`orca-tab-${target.browserPageId}`)
          }
          throw new BrowserError(
            'browser_error',
            `Failed to navigate browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          if (navigationTimeout) {
            clearTimeout(navigationTimeout)
          }
        }

        // Why: cross-process navigation can replace the guest while retaining the same authoritative page id.
        const navigatedTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
        const navigatedWebContents = this.requireTargetWebContents(navigatedTarget)
        return { url: navigatedWebContents.getURL(), title: navigatedWebContents.getTitle() }
      },
      { ensureSession: false }
    )
  }

  async fill(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFillResult> {
    await assertClipboardTextWriteWithinLimitWithYield(value)
    // Why: agent-browser's CDP text insertion loses focus in Electron guests; edit through the browser's input pipeline instead.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
          await this.execAgentBrowser(sessionName, ['focus', element])
          await this.execAgentBrowser(sessionName, [
            'eval',
            focusedValueSetExpression(JSON.stringify(''))
          ])
          for (const chunk of iterateBrowserTextInsertionChunks(
            value,
            AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
          )) {
            await this.execAgentBrowser(sessionName, [
              'eval',
              focusedValueSetExpression(JSON.stringify(chunk), { append: true })
            ])
          }
          await this.execAgentBrowser(sessionName, [
            'eval',
            focusedValueSetExpression(JSON.stringify(''), { append: true, dispatchEvents: true })
          ])
          return { filled: element } as BrowserFillResult
        }

        await this.fillExplicitContentEditable(sessionName, element, value)
        return { filled: element } as BrowserFillResult
      },
      { requireScopedTarget: true }
    )
  }

  async type(
    input: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTypeResult> {
    await assertClipboardTextWriteWithinLimitWithYield(input)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        for (const chunk of iterateBrowserTextInsertionChunks(
          input,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          await this.execAgentBrowser(sessionName, ['keyboard', 'type', chunk])
        }
        return { typed: true } as BrowserTypeResult
      },
      { requireScopedTarget: true }
    )
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
    await assertClipboardTextWriteWithinLimitWithYield(text)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        let result: unknown = { inserted: true }
        for (const chunk of iterateBrowserTextInsertionChunks(
          text,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          result = await this.execAgentBrowser(sessionName, ['keyboard', 'inserttext', chunk])
        }
        return result
      },
      { requireScopedTarget: true }
    )
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

  async mouseClick(
    x: number,
    y: number,
    button?: string,
    worktreeId?: string,
    browserPageId?: string,
    radius?: number,
    modifiers?: BrowserMouseModifier[]
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.getWebContents(target.webContentsId)
        if (!wc || wc.isDestroyed()) {
          throw new BrowserError(
            'browser_tab_not_found',
            `Browser page ${target.browserPageId} is no longer available`
          )
        }
        const cdpButton = normalizeCdpMouseButton(button)
        const buttons = cdpMouseButtonMask(cdpButton)
        const cdpModifiers = cdpMouseModifierMask(modifiers)
        const lease = acquireElectronDebugger(wc)
        try {
          wc.focus()
          const point =
            cdpButton === 'left'
              ? // Why: DOM activation can't carry Cmd/Ctrl/Alt/Shift, so modifier clicks use the adjusted point and let CDP dispatch the event.
                await resolveMobileTouchClickPoint(wc.debugger, x, y, radius, cdpModifiers === 0)
              : { x, y, adjusted: false, handled: false }
          // Why: land the tap as one atomic op — separate move/down/up CLI calls visibly hover and can miss small controls.
          // Why: mobile-emulated BrowserViews can ignore CDP mouse clicks, so the runtime may already have activated DOM controls.
          if (!point.handled) {
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: point.x,
              y: point.y,
              button: cdpButton,
              buttons,
              modifiers: cdpModifiers,
              clickCount: 1
            })
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: point.x,
              y: point.y,
              button: cdpButton,
              buttons: 0,
              modifiers: cdpModifiers,
              clickCount: 1
            })
          }
          return {
            clicked: {
              x: point.x,
              y: point.y,
              button: cdpButton,
              adjusted: point.adjusted,
              handled: point.handled
            }
          }
        } finally {
          lease.release()
        }
      },
      { ensureSession: false }
    )
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
    await assertClipboardTextWriteWithinLimitWithYield(text, {
      maxBytes: AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
    })
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
    // Why: reload can trigger an Electron process swap that destroys the session mid-command — reload via webContents directly instead.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      wc.reload()
      await new Promise<void>((resolve) => {
        let settled = false
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null

        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          if (fallbackTimer) {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
          }
          resolve()
        }
        const onFinish = (): void => finish()
        const onFail = (): void => finish()

        wc.on('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        // Why: clear the fallback timer on load; otherwise each reload leaks the webContents + listeners until the 10s timeout.
        fallbackTimer = setTimeout(finish, 10_000)
        if (typeof fallbackTimer.unref === 'function') {
          fallbackTimer.unref()
        }
      })
      return { url: wc.getURL(), title: wc.getTitle() }
    })
  }

  async screenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why: agent-browser writes the screenshot to a temp file and returns its path; read it and return base64.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return this.captureScreenshotCommand(sessionName, ['screenshot'], 300, format)
      },
      { ensureVisible: false }
    )
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        return this.captureFullPageScreenshotCommand(
          sessionName,
          target.webContentsId,
          500,
          format === 'jpeg' ? 'jpeg' : 'png'
        )
      },
      { ensureVisible: false }
    )
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
        ? await this.browserManager.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      try {
        // Why: let the compositor settle to a painted frame after the lease, inside the screenshot lock so another tab can't change lease state first.
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
        ? await this.browserManager.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      try {
        // Why: the guest compositor needs a beat to paint a fresh frame after becoming paintable, or CDP captures a stale surface.
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          const { result, exceptionDetails } = (await wc.debugger.sendCommand('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
          })) as {
            result: { value?: unknown; description?: string }
            exceptionDetails?: { text: string; exception?: { description?: string } }
          }
          if (exceptionDetails) {
            throw new BrowserError(
              'browser_eval_error',
              exceptionDetails.exception?.description ?? exceptionDetails.text
            )
          }

          const currentTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
          if (currentTarget.webContentsId !== target.webContentsId) {
            throw new BrowserError(
              'browser_tab_changed',
              `Browser page ${target.browserPageId} changed while evaluating; retry the command`
            )
          }
          return {
            result:
              result.value !== undefined
                ? typeof result.value === 'object' && result.value !== null
                  ? JSON.stringify(result.value)
                  : String(result.value)
                : (result.description ?? ''),
            origin: wc.getURL()
          }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(`orca-tab-${target.browserPageId}`)
          }
          throw new BrowserError(
            'browser_error',
            `Failed to evaluate in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false }
    )
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
      // Why: agent-browser's selector wait lacks a per-command timeout — enforce it here so a missing selector fails as browser_timeout, not a hang.
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
          // Why: agent-browser resolves the ref directly, preserving iframe/shadow-root/unfocusable semantics for ordinary fields.
          await this.execAgentBrowser(sessionName, ['fill', element, ''])
          return { cleared: element }
        }

        await this.fillExplicitContentEditable(sessionName, element, '')
        return { cleared: element }
      },
      { requireScopedTarget: true }
    )
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
    // Why: agent-browser's CDP printToPDF hangs in Electron webviews — use the native webContents.printToPDF().
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

      // Why: agent-browser's `set viewport` has no `mobile` flag, so apply the emulation directly via CDP to honor Orca's --mobile.
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      })
      // Why: BrowserView's compositor can keep the old host size after a metrics-only resize, cropping remote screencast clients.
      await Promise.resolve(dbg.sendCommand('Emulation.setVisibleSize', { width, height })).catch(
        () => {}
      )

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

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request decisions, not just URL-pattern routing.

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
      // Why: strip target/session flags from passthrough so a caller can't override Orca's selected page or CDP proxy.
      const args = stripAgentBrowserTargetArgs(parseShellArgs(command.trim()))
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
    this.pendingInterceptRestore.clear()
  }

  // ── Internal ──

  private async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(
      worktreeId,
      undefined,
      async (sessionName) => execute(sessionName),
      { ensureVisible: false }
    )
  }

  private async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    const target = this.resolveCommandTarget(worktreeId, browserPageId, options.requireScopedTarget)
    const sessionName = `orca-tab-${target.browserPageId}`

    if (options.ensureSession !== false) {
      await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)
    }

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: (() =>
          this.executeWithVisibleTarget(
            sessionName,
            worktreeId,
            target,
            execute,
            options
          )) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  private async executeWithVisibleTarget<T>(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    if (options.ensureVisible === false) {
      return execute(sessionName, target)
    }

    // Why: inactive panes are display:none; the automation lease makes only this target paintable without selecting it.
    const restore = await this.browserManager.acquireAutomationVisibility(target.webContentsId)
    try {
      const visibleTarget = await this.refreshTargetAfterAutomationVisibility(
        sessionName,
        worktreeId,
        target,
        options
      )
      return await execute(sessionName, visibleTarget)
    } finally {
      restore()
    }
  }

  private async refreshTargetAfterAutomationVisibility(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    options: EnqueueTargetedCommandOptions
  ): Promise<ResolvedBrowserCommandTarget> {
    const visibleTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
    if (visibleTarget.webContentsId === target.webContentsId) {
      return visibleTarget
    }

    if (this.activeWebContentsId === target.webContentsId) {
      this.activeWebContentsId = visibleTarget.webContentsId
    }
    if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === target.webContentsId) {
      this.activeWebContentsPerWorktree.set(worktreeId, visibleTarget.webContentsId)
    }

    // Why: making a parked webview paintable can re-register the page with a new guest webContents; tear down the stale session.
    await this.restartSessionForTarget(
      sessionName,
      visibleTarget.browserPageId,
      visibleTarget.webContentsId,
      { recreate: options.ensureSession !== false }
    )

    return visibleTarget
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

    if (queue && queue.length === 0 && this.commandQueues.get(sessionName) === queue) {
      this.commandQueues.delete(sessionName)
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
    browserPageId?: string,
    requireScopedTarget = false
  ): ResolvedBrowserCommandTarget {
    if (!browserPageId) {
      return requireScopedTarget
        ? this.resolveScopedActiveTab(worktreeId)
        : this.resolveActiveTab(worktreeId)
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
      this.browserManager.unregisterGuest(browserPageId)
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

    // Why: prefer per-worktree active tab to avoid cross-worktree interference; fall back to global for callers without worktreeId.
    const preferredWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId

    if (preferredWcId != null) {
      for (const [tabId, wcId] of tabs) {
        if (wcId === preferredWcId && this.getWebContents(wcId)) {
          return { browserPageId: tabId, webContentsId: wcId }
        }
        if (wcId === preferredWcId) {
          this.browserManager.unregisterGuest(tabId)
          if (this.activeWebContentsId === wcId) {
            this.activeWebContentsId = null
          }
          if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === wcId) {
            this.activeWebContentsPerWorktree.delete(worktreeId)
          }
        }
      }
    }

    // Why: persisted state can leave ghost tabs (dead webContents); skip them and activate the first live tab for consistency.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        this.activeWebContentsId = wcId
        if (worktreeId) {
          this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        }
        return { browserPageId: tabId, webContentsId: wcId }
      }
      this.browserManager.unregisterGuest(tabId)
    }

    throw new BrowserError(
      'browser_no_tab',
      'No live browser tab available — all registered tabs have been destroyed'
    )
  }

  // Why: don't fall back to the global tab for text mutation — it could inject into another worktree's foreground webview and steal focus.
  private resolveScopedActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    if (worktreeId) {
      return this.resolveActiveTab(worktreeId)
    }

    const worktreesWithLiveTabs = new Set<string | undefined>()
    for (const [tabId, wcId] of this.getRegisteredTabs(undefined)) {
      if (this.getWebContents(wcId)) {
        worktreesWithLiveTabs.add(this.browserManager.getWorktreeIdForTab(tabId))
      }
    }

    if (worktreesWithLiveTabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    if (worktreesWithLiveTabs.size > 1) {
      throw new BrowserError(
        'browser_target_ambiguous',
        'Multiple worktrees have browser tabs open; pass --worktree to target text insertion safely'
      )
    }

    const [onlyWorktreeId] = worktreesWithLiveTabs
    return this.resolveActiveTab(onlyWorktreeId)
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

    // Why: without this lock, two concurrent calls both create proxies and the second leaks the first's server/debugger.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        // Why: the webview can be destroyed between target resolution and session creation — keep the same closed-tab error shape.
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${browserPageId} is no longer available`
        )
      }

      // Why: the daemon persists sessions (incl. CDP port) across restarts; close the stale one first or it ignores --cdp and hits the dead port.
      await this.closeStaleAgentBrowserSession(sessionName)

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

  private async restartSessionForTarget(
    sessionName: string,
    browserPageId: string,
    webContentsId: number,
    options: { recreate: boolean } = { recreate: true }
  ): Promise<void> {
    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      await pendingCreation.catch(() => {})
    }

    const session = this.sessions.get(sessionName)
    if (session) {
      if (session.activeInterceptPatterns.length > 0) {
        this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
      }
      this.sessions.delete(sessionName)
      this.pendingSessionCreation.delete(sessionName)
      if (session.activeProcess) {
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
          await this.runAgentBrowserRaw(sessionName, ['--session', sessionName, 'close'])
        } catch {
          // Session may already be dead.
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

    if (options.recreate) {
      await this.ensureSession(sessionName, browserPageId, webContentsId)
    }
  }

  private async destroySession(sessionName: string): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
      return
    }

    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      // Why: tab close can race session creation before sessions.set(); await it so no late proxy survives the close.
      try {
        await pendingCreation
      } catch {
        // Creation failures are handled by the original caller; teardown still rejects queued work below.
      }
    }

    const session = this.sessions.get(sessionName)
    if (!session) {
      this.rejectQueuedCommandsForClosedSession(sessionName)
      return
    }

    this.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)

    // Why: queued commands would hang forever if we just delete the queue — drain and reject them.
    this.rejectQueuedCommandsForClosedSession(sessionName)

    if (session.activeProcess) {
      // Why: rejecting the queue isn't enough for an in-flight command — kill the process so callers don't wait out the exec timeout.
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
        // Why: each tab has its own named session — close without --session leaves this tab's daemon running.
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

  private rejectQueuedCommandsForClosedSession(sessionName: string): void {
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
  }

  private async execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      // Why: a queued command can run after a concurrent close deleted the session — surface a tab-lifecycle error, not an opaque failure.
      throw this.createPageUnavailableError(sessionName)
    }

    // Why: the webContents can be destroyed during queue delay — check here to avoid cryptic Electron debugger errors.
    if (!this.getWebContents(session.webContentsId)) {
      await this.destroySession(sessionName)
      throw this.createPageUnavailableError(sessionName)
    }

    const args = ['--session', sessionName]
    const managesInterceptRoutes =
      commandArgs[0] === 'network' && (commandArgs[1] === 'route' || commandArgs[1] === 'unroute')

    const needsInit = !session.initialized
    // Why: a restarted named daemon auto-launches Chrome unless every invocation reasserts Orca's CDP owner.
    args.push('--cdp', String(session.proxy.getPort()))

    // Why: exec passthrough can produce a large argv; spreading into push risks V8 argument limits.
    for (const commandArg of commandArgs) {
      args.push(commandArg)
    }
    args.push('--json')

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

    // Why: mark initialized only after success, so a failed first --cdp connection retries with --cdp.
    if (needsInit) {
      session.initialized = true

      // Why: a process swap loses intercept patterns — restore them now unless the caller's first command reconfigured routing.
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
            '--cdp',
            String(session.proxy.getPort()),
            'network',
            'route',
            urlPattern,
            '--json'
          ])
          session.activeInterceptPatterns = pendingPatterns
        } catch {
          // Why: intercept restore is best-effort — don't fail the user's command if the new page can't support it.
        }
      }
    }

    return translated.result
  }

  private async isExplicitContentEditableTarget(
    sessionName: string,
    element: string
  ): Promise<boolean> {
    const result = await this.execAgentBrowser(sessionName, [
      'get',
      'attr',
      element,
      'contenteditable'
    ])
    return isExplicitContentEditableResult(result)
  }

  private async fillExplicitContentEditable(
    sessionName: string,
    element: string,
    value: string
  ): Promise<void> {
    await this.execAgentBrowser(sessionName, ['focus', element])
    // Why: stdin avoids argv limits and keeps replacement atomic; chunked edits can move focus and split a fill across controls.
    await this.execAgentBrowser(sessionName, ['eval', '--stdin'], {
      stdinText: focusedRichTextEditExpression(JSON.stringify(value), { selectAll: true })
    })
  }

  private createPageUnavailableError(sessionName: string): BrowserError {
    return new BrowserError('browser_tab_not_found', pageUnavailableMessageForSession(sessionName))
  }

  private closeStaleAgentBrowserSession(sessionName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof execFile> | null = null
      let settled = false

      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      // Why: proceeding after an unverified close can reuse a daemon that owns an unrelated browser.
      const timeout = setTimeout(() => {
        child?.kill()
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}; retry after agent-browser exits`
          )
        )
      }, STALE_SESSION_CLOSE_TIMEOUT_MS)

      try {
        child = execFile(
          this.agentBrowserBin,
          ['--session', sessionName, 'close'],
          { timeout: STALE_SESSION_CLOSE_TIMEOUT_MS },
          (error) =>
            finish(
              error
                ? new BrowserError(
                    'browser_owner_unavailable',
                    `Could not reset stale helper session ${sessionName}: ${error.message}`
                  )
                : undefined
            )
        )
      } catch (error) {
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    })
  }

  private createCommandError(
    sessionName: string,
    message: string,
    fallbackCode: string,
    webContentsId?: number
  ): BrowserError {
    // Why: CDP "connection refused" can also mean a real proxy failure — only map to closed-page when the target is confirmed gone.
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
        // Why: screenshots return large base64 that exceeds Node's default 1MB maxBuffer (ENOBUFS).
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
            // Why: agent-browser exits non-zero on failure but still writes structured JSON to stdout — parse it for the real error.
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
      if (execOptions?.stdinText !== undefined && child?.stdin) {
        // Why: eval --stdin keeps paste-sized scripts out of argv on every platform.
        child.stdin.on('error', () => {})
        child.stdin.end(execOptions.stdinText)
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

  private requireTargetWebContents(target: ResolvedBrowserCommandTarget): WebContents {
    const wc = this.getWebContents(target.webContentsId)
    if (!wc || wc.isDestroyed()) {
      throw this.createPageUnavailableError(`orca-tab-${target.browserPageId}`)
    }
    return wc
  }

  private getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      const target = webContents.fromId(webContentsId)
      return target && !target.isDestroyed() ? target : null
    } catch {
      return null
    }
  }
}
