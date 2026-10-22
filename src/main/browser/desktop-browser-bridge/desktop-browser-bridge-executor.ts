/**
 * Runs one browser command a managed SSH host forwarded, on this desktop, inside that host's scope:
 * an allowlisted method, against a workspace this desktop shows as the host's own, with every
 * workspace selector pinned to it. Every outcome is audit-logged; params are not, since they can
 * carry typed secrets.
 */
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
import { iterateBrowserTextInsertionChunks } from '../browser-text-insertion'
import { AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES } from '../agent-browser-bridge-types'

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
  /**
   * The workspace this desktop shows as owned by the environment's own machine for the named page
   * and/or workspace, or null. A page that has not mounted yet is known only to the renderer.
   */
  resolveWorkspace(scope: {
    workspaceId: string | null
    page: string | null
  }): Promise<string | null>
  /** The workspace a mounted page registered under, if it has mounted. */
  worktreeIdForPage(browserPageId: string): string | null
  /** Records that a host drives this workspace's pages, so they lose programmatic clipboard reads. */
  markWorkspaceDriven(workspaceId: string): void
  /** True when this host's desktop tabs browse through the host (SSH browser routing on for it). */
  isHostBrowsingRouted(): boolean
  /** True only for a guest whose session is this host's prepared SSH route partition. */
  isGuestRoutedThroughHost(webContentsId: number): boolean
  dispatch(method: string, params: Record<string, unknown>): Promise<RpcResponse>
  audit(entry: DesktopBrowserBridgeAuditEntry): void
}

// Why: a host may not pick the desktop page id, tab group, focus or browser profile of a new tab.
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
  /** Aborted when the bridge detaches; a command not yet dispatched must then never run. */
  signal?: AbortSignal,
  /** Aborted only when the bridge detaches, not when this one command is cancelled. */
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
  // Why again here: the desktop is the trust boundary, never what the host claims it checked.
  if (!isDesktopBrowserBridgeMethod(request.method)) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${request.method} cannot run on this desktop from an SSH host.`
    )
  }
  // Why: an unrouted page egresses from this desktop, so a host could reach its loopback and LAN.
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
    // Why: a bare path normalizes to file:// and loadURL skips the guest navigation guard.
    throw new BridgeRefusal(
      'invalid_argument',
      'An SSH host can open only http:// or https:// URLs in the desktop browser. Pass the full URL.'
    )
  }
  assertNoOptionLikeArguments(request.method, params)
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
    // Why the same refusal for a foreign page: an unknown and a forbidden page must look alike.
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

// Params that never reach agent-browser's argv: eval runs over CDP, fill writes through stdin.
const NON_ARGV_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'browser.eval': ['expression'],
  'browser.fill': ['value']
}
// Params agent-browser receives as argv in fixed-size chunks, so every chunk start is an argument.
const CHUNKED_ARGV_PARAMS: Readonly<Record<string, string>> = {
  'browser.type': 'input',
  'browser.keyboardInsertText': 'text'
}

/**
 * agent-browser reads its global options (such as --cdp) anywhere in argv, so a host value that
 * starts with "-" could repoint the command at another page's proxy. Refuse it rather than escape.
 */
function assertNoOptionLikeArguments(method: string, params: Record<string, unknown>): void {
  const exempt = new Set(NON_ARGV_PARAMS[method] ?? [])
  const chunked = CHUNKED_ARGV_PARAMS[method]
  for (const [name, value] of Object.entries(params)) {
    if (name === 'worktree' || name === 'page' || exempt.has(name)) {
      continue
    }
    const values =
      name === chunked && typeof value === 'string'
        ? [...iterateBrowserTextInsertionChunks(value, AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES)]
        : Array.isArray(value)
          ? value
          : [value]
    if (values.some((entry) => typeof entry === 'string' && entry.trimStart().startsWith('-'))) {
      throw new BridgeRefusal(
        'invalid_argument',
        `An SSH host cannot send a --${name} value that starts with "-". Rephrase it, or type it with orca fill.`
      )
    }
  }
}

const CTRL_OR_META = 2 | 4
const SHIFT = 8
const PASTE_MODIFIER_NAMES = new Set(['control', 'ctrl', 'meta', 'cmd', 'command', 'super', 'win'])

// Why the input parser first: the key must be judged as the event the page receives, aliases and all.
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
  // A spelling the parser cannot express falls back to the raw driver, so refuse it by name too.
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

// Why: a user can open a desktop file in a routed tab; its document is still this desktop's file.
// chrome-error: is Chromium's own load-failure page, which a host must be able to navigate away from.
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
