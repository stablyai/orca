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
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser/navigation/browser-url'
import type { RpcResponse } from '../../runtime/rpc/core'
import { BrowserError } from '../browser-error'
import { runInRemoteCliBrowserScope } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { isPasteChord } from '../cdp/input/browser-paste-chord'
import type { DesktopBrowserBridgeHostChannel } from './desktop-browser-bridge-connection'
import type { DesktopBrowserBridgeHostFiles } from './desktop-browser-bridge-host-files'

export type DesktopBrowserBridgeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; data?: unknown } }

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
  /** The SSH host the bridge serves; its tabs say it is controlling them. */
  targetId: string
  hostLabel: string
  /** Resolve host ownership via the renderer, which also knows unmounted pages; throws BrowserError when it can't answer. */
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
  /** Moves the host's own files for upload and download. */
  hostFiles: DesktopBrowserBridgeHostFiles
  audit(entry: DesktopBrowserBridgeAuditEntry): void
}

// Hosts cannot choose a new tab's desktop identity or group; --split only places it beside the caller.
const TAB_CREATE_STRIPPED_PARAMS = ['page', 'placement', 'targetGroupId', 'navigation'] as const

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
  hostRevoked?: AbortSignal,
  host?: DesktopBrowserBridgeHostChannel
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
    audit.urlOrigin = urlOrigin(params.url)
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
      () => dispatchForHost(request.method, params, workspaceId, deps, host),
      signal,
      (webContentsId) =>
        deps.isHostBrowsingRouted() && deps.isGuestRoutedThroughHost(webContentsId),
      hostRevoked,
      { targetId: deps.targetId, hostLabel: deps.hostLabel }
    )
    if (!response.ok) {
      deps.audit({ ...audit, outcome: 'failed', code: response.error.code })
      return { ok: false, error: response.error }
    }
    deps.audit({ ...audit, outcome: 'ok' })
    return { ok: true, result: response.result }
  } catch (error) {
    if (error instanceof BridgeRefusal) {
      deps.audit({ ...audit, outcome: 'refused', code: error.code })
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    if (error instanceof BrowserError) {
      deps.audit({ ...audit, outcome: 'failed', code: error.code })
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.audit({ ...audit, outcome: 'failed', code: 'runtime_error' })
    return { ok: false, error: { code: 'runtime_error', message } }
  }
}

// Upload and download name the host's files; never let those paths reach a desktop command.
function dispatchForHost(
  method: string,
  params: Record<string, unknown>,
  workspaceId: string,
  deps: DesktopBrowserBridgeExecutorDeps,
  host: DesktopBrowserBridgeHostChannel | undefined
): Promise<RpcResponse> {
  if (method !== 'browser.upload' && method !== 'browser.download') {
    return deps.dispatch(method, params)
  }
  if (!host) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${method} cannot run on this desktop from an SSH host.`
    )
  }
  const dispatch = (next: Record<string, unknown>): Promise<RpcResponse> =>
    deps.dispatch(method, next)
  return method === 'browser.upload'
    ? deps.hostFiles.upload(params, workspaceId, host, dispatch)
    : deps.hostFiles.download(params, host, dispatch)
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
    // Refused, not dropped: the host would otherwise believe its tab used the profile.
    if (params.profileId !== undefined) {
      throw new BridgeRefusal(
        'invalid_argument',
        'tab create --profile is not available from an SSH host; the desktop picks the profile for new tabs. Drop --profile, or open the tab on the desktop.'
      )
    }
    for (const key of TAB_CREATE_STRIPPED_PARAMS) {
      delete params[key]
    }
    // Only an explicit --focus shows the tab, as for a local CLI create.
    if (params.activate !== true) {
      delete params.activate
    }
  }
  if (request.method === 'browser.goto' || request.method === 'browser.tabCreate') {
    const url = webNavigationUrl(params.url, request.method === 'browser.tabCreate')
    if (url === null) {
      // Bare paths become file: URLs, and loadURL bypasses the guest navigation guard.
      throw new BridgeRefusal(
        'invalid_argument',
        'An SSH host can open only http:// or https:// URLs in the desktop browser.'
      )
    }
    if (url !== undefined) {
      params.url = url
    }
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

// Scheme-less addresses normalise as they do for local CLI tabs; anything but http(s) is refused.
function webNavigationUrl(value: unknown, optional: boolean): string | undefined | null {
  if (value === undefined && optional) {
    return undefined
  }
  if (typeof value !== 'string') {
    return null
  }
  if (value === 'about:blank') {
    return value
  }
  const normalized = normalizeBrowserNavigationUrl(value)
  if (!normalized) {
    return null
  }
  const protocol = new URL(normalized).protocol
  return protocol === 'http:' || protocol === 'https:' ? normalized : null
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
