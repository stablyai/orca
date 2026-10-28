// Audit outcomes and URL origins only; request parameters can contain secrets.
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL,
  DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL,
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE,
  isDesktopBrowserBridgeMethod,
  type DesktopBrowserBridgeRequest
} from '../../../shared/desktop-browser-bridge-protocol'
import type { RpcResponse } from '../../runtime/rpc/core'
import { runInRemoteCliBrowserScope } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { parseCdpKeyEvent } from '../cdp-keyboard-us-layout'

export type DesktopBrowserBridgeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

export type DesktopBrowserBridgeAuditEntry = {
  environmentId: string
  hostLabel: string
  method: string
  workspaceId: string | null
  page: string | null
  urlOrigin: string | null
  outcome: 'ok' | 'refused' | 'failed'
  code?: string
}

export type DesktopBrowserBridgeExecutorDeps = {
  environmentId: string
  hostLabel: string
  /** Resolve host ownership via the renderer, which also knows unmounted pages. */
  resolveWorkspace(scope: {
    workspaceId: string | null
    page: string | null
  }): Promise<string | null>
  worktreeIdForPage(browserPageId: string): string | null
  /** Host-driven workspaces lose programmatic clipboard reads. */
  markWorkspaceDriven(workspaceId: string): void
  isHostBrowsingRouted(): boolean
  /** Requires this host's prepared SSH route partition. */
  isGuestRoutedThroughHost(webContentsId: number): boolean
  dispatch(method: string, params: Record<string, unknown>): Promise<RpcResponse>
  audit(entry: DesktopBrowserBridgeAuditEntry): void
}

// Hosts cannot choose a new tab's desktop identity, profile, group or focus.
const TAB_CREATE_STRIPPED_PARAMS = [
  'page',
  'profileId',
  'placement',
  'targetGroupId',
  'activate',
  'navigation'
] as const

class BridgeRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function executeDesktopBrowserBridgeRequest(
  request: DesktopBrowserBridgeRequest,
  deps: DesktopBrowserBridgeExecutorDeps,
  /** Command cancellation, deadline or bridge revocation; blocks queued dispatch. */
  signal?: AbortSignal,
  /** Attachment revocation only; per-command cancellation leaves this signal active. */
  hostRevoked?: AbortSignal
): Promise<DesktopBrowserBridgeOutcome> {
  const audit: Omit<DesktopBrowserBridgeAuditEntry, 'outcome' | 'code'> = {
    environmentId: deps.environmentId,
    hostLabel: deps.hostLabel,
    method: request.method,
    workspaceId: null,
    page: null,
    urlOrigin: urlOrigin(request.params.url)
  }
  try {
    const { params, workspaceId, page } = await scopeRequest(request, deps)
    audit.workspaceId = workspaceId
    audit.page = page
    if (signal?.aborted) {
      throw new BridgeRefusal(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser before this command ran.'
      )
    }
    deps.markWorkspaceDriven(workspaceId)
    const response = await runInRemoteCliBrowserScope(
      workspaceId,
      () => deps.dispatch(request.method, params),
      signal,
      (webContentsId) =>
        deps.isHostBrowsingRouted() && deps.isGuestRoutedThroughHost(webContentsId),
      hostRevoked
    )
    if (!response.ok) {
      deps.audit({ ...audit, outcome: 'failed', code: response.error.code })
      return { ok: false, error: { code: response.error.code, message: response.error.message } }
    }
    deps.audit({ ...audit, outcome: 'ok' })
    return { ok: true, result: response.result }
  } catch (error) {
    if (error instanceof BridgeRefusal) {
      deps.audit({ ...audit, outcome: 'refused', code: error.code })
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.audit({ ...audit, outcome: 'failed', code: 'runtime_error' })
    return { ok: false, error: { code: 'runtime_error', message } }
  }
}

async function scopeRequest(
  request: DesktopBrowserBridgeRequest,
  deps: DesktopBrowserBridgeExecutorDeps
): Promise<{ params: Record<string, unknown>; workspaceId: string; page: string | null }> {
  // Enforce the method allowlist on the desktop rather than trusting the host.
  if (!isDesktopBrowserBridgeMethod(request.method)) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${request.method} cannot run on this desktop from an SSH host.`
    )
  }
  // Unrouted pages could expose the desktop's loopback and LAN to the host.
  if (!deps.isHostBrowsingRouted()) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE,
      `This host's browser tabs browse from your desktop's own network, so its orca CLI cannot use them. Set ${DESKTOP_BROWSER_BRIDGE_ROUTING_SETTING_LABEL} to "SSH host" and, if this host is listed under "${DESKTOP_BROWSER_BRIDGE_ROUTING_OPT_OUT_LABEL}", click "Use SSH host".`
    )
  }
  const params: Record<string, unknown> = { ...request.params }
  if (request.method === 'browser.tabCreate') {
    for (const key of TAB_CREATE_STRIPPED_PARAMS) {
      delete params[key]
    }
  }
  if (
    (request.method === 'browser.goto' || request.method === 'browser.tabCreate') &&
    !isWebNavigationUrl(params.url, request.method === 'browser.tabCreate')
  ) {
    // Bare paths become file: URLs, and loadURL bypasses the guest navigation guard.
    throw new BridgeRefusal(
      'invalid_argument',
      'An SSH host can open only http:// or https:// URLs in the desktop browser. Pass the full URL.'
    )
  }
  if (request.method === 'browser.keypress' && isPasteChord(params.key)) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      'An SSH host cannot paste from the desktop clipboard. Use orca type or orca fill instead.'
    )
  }
  const requestedWorkspaceId = request.workspaceId ?? null
  if (
    params.worktree !== undefined &&
    (!requestedWorkspaceId || params.worktree !== `id:${requestedWorkspaceId}`)
  ) {
    throw outOfScope()
  }
  const page = typeof params.page === 'string' && params.page.length > 0 ? params.page : null
  if (!requestedWorkspaceId && !page) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'Run this command inside a workspace on this host, or pass --worktree, so Orca knows which workspace’s browser tabs it may use.'
    )
  }
  const workspaceId = await deps.resolveWorkspace({ workspaceId: requestedWorkspaceId, page })
  const mountedWorkspaceId = page ? deps.worktreeIdForPage(page) : null
  if (!workspaceId || (mountedWorkspaceId && mountedWorkspaceId !== workspaceId)) {
    // Do not reveal whether a forbidden page exists.
    throw page
      ? new BridgeRefusal('browser_tab_not_found', `Browser page ${page} was not found`)
      : outOfScope()
  }
  params.worktree = `id:${workspaceId}`
  return { params, workspaceId, page }
}

function isWebNavigationUrl(value: unknown, optional: boolean): boolean {
  if (value === undefined && optional) {
    return true
  }
  if (typeof value !== 'string') {
    return false
  }
  if (value === 'about:blank') {
    return true
  }
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const CTRL_OR_META = 2 | 4
const SHIFT = 8
const PASTE_MODIFIER_NAMES = new Set(['control', 'ctrl', 'meta', 'cmd', 'command', 'super', 'win'])

// Match the actual key event, including aliases.
function isPasteChord(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const event = parseCdpKeyEvent(value)
  if (event) {
    return (
      (event.code === 'KeyV' && (event.modifiers & CTRL_OR_META) !== 0) ||
      (event.code === 'Insert' && (event.modifiers & SHIFT) !== 0)
    )
  }
  // Unparsed spellings reach the raw driver; check their paste aliases too.
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const key = parts.at(-1)
  const modifiers = parts.slice(0, -1)
  return (
    (key === 'v' && modifiers.some((modifier) => PASTE_MODIFIER_NAMES.has(modifier))) ||
    ((key === 'insert' || key === 'ins') && modifiers.includes('shift'))
  )
}

function outOfScope(): BridgeRefusal {
  return new BridgeRefusal(
    DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
    'An SSH host can only reach browser tabs in its own workspaces.'
  )
}

function urlOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// Routed tabs can still display local files; those remain off-limits to hosts.
// Allow chrome-error: so hosts can navigate away from failed loads.
const HOST_REACHABLE_DOCUMENT_PROTOCOLS = new Set([
  'http:',
  'https:',
  'about:',
  'blob:',
  'data:',
  'chrome-error:'
])

export function isHostReachableDocument(url: string): boolean {
  try {
    return HOST_REACHABLE_DOCUMENT_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return url === ''
  }
}
