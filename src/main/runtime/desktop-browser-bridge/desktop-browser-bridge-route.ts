/** Only orcad-local CLI browser calls forward to desktops; paired clients must never bounce back. */
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE,
  isDesktopBrowserBridgeMethod
} from '../../../shared/desktop-browser-bridge-protocol'
import { browserWaitRequestTimeoutMs } from '../../../shared/browser-wait-timeout'
import type { RpcCallerIdentity } from '../rpc/rpc-caller-identity'
import { assertClientOpenableUrl } from '../browser/browser-client-page-opening'
import type { DesktopBrowserBridgeRegistry } from './desktop-browser-bridge-registry'

export type DesktopBrowserBridgeRoute = { handled: false } | { handled: true; result: unknown }

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 10 * 60_000

export async function routeDesktopBrowserBridgeRpc(options: {
  method: string
  params: unknown
  caller: RpcCallerIdentity | undefined
  hostEnabled: boolean
  registry: DesktopBrowserBridgeRegistry
  localBrowserAvailable: boolean
  resolveWorkspace(selector: string): Promise<{ id: string }>
  signal?: AbortSignal
}): Promise<DesktopBrowserBridgeRoute> {
  const { method } = options
  if (
    !options.hostEnabled ||
    options.caller?.kind !== 'local-cli' ||
    !method.startsWith('browser.')
  ) {
    return { handled: false }
  }
  // Map open-url to older desktops' tabCreate surface, preserving scope/URL/focus rules.
  const forwardedMethod = method === 'browser.openUrl' ? 'browser.tabCreate' : method
  const forwarded = isDesktopBrowserBridgeMethod(forwardedMethod)
  if (!options.registry.hasAttachment()) {
    if (options.localBrowserAvailable || !forwarded) {
      return { handled: false }
    }
    throw new BrowserError(
      DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
      DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE
    )
  }
  if (!forwarded) {
    if (options.localBrowserAvailable) {
      return { handled: false }
    }
    throw new BrowserError(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${method} is not available from an SSH host. The desktop browser accepts navigation, page reading and input commands only.`
    )
  }
  const params: Record<string, unknown> = isRecord(options.params) ? { ...options.params } : {}
  if (method === 'browser.openUrl') {
    assertClientOpenableUrl(String(params.url))
  }
  let workspaceId: string | undefined
  // Only orcad can resolve its host's path/branch/active selectors.
  if (typeof params.worktree === 'string' && params.worktree.length > 0) {
    workspaceId = (await options.resolveWorkspace(params.worktree)).id
    params.worktree = `id:${workspaceId}`
  } else {
    delete params.worktree
  }
  const result = await options.registry.forward(
    { method: forwardedMethod, params, ...(workspaceId ? { workspaceId } : {}) },
    { timeoutMs: forwardTimeoutMs(forwardedMethod, params), signal: options.signal }
  )
  return { handled: true, result }
}

function forwardTimeoutMs(method: string, params: Record<string, unknown>): number {
  return method === 'browser.wait'
    ? Math.min(browserWaitRequestTimeoutMs(params.timeout), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
