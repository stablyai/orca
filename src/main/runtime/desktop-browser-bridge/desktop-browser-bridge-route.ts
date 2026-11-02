/**
 * Decides, on orcad, whether a browser RPC from this host's own `orca` CLI goes to an attached
 * desktop. Only the local CLI is forwarded: a paired client calling orcad is never bounced back
 * to a desktop.
 */
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE,
  isDesktopBrowserBridgeMethod
} from '../../../shared/desktop-browser-bridge-protocol'
import type { RpcCallerIdentity } from '../rpc/rpc-caller-identity'
import type { DesktopBrowserBridgeRegistry } from './desktop-browser-bridge-registry'

export type DesktopBrowserBridgeRoute = { handled: false } | { handled: true; result: unknown }

const DEFAULT_TIMEOUT_MS = 60_000
const WAIT_MARGIN_MS = 30_000
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
  const forwarded = isDesktopBrowserBridgeMethod(method)
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
  let workspaceId: string | undefined
  // Why resolve here: only orcad knows this host's selectors (path:, branch:, active).
  if (typeof params.worktree === 'string' && params.worktree.length > 0) {
    workspaceId = (await options.resolveWorkspace(params.worktree)).id
    params.worktree = `id:${workspaceId}`
  } else {
    delete params.worktree
  }
  const result = await options.registry.forward(
    { method, params, ...(workspaceId ? { workspaceId } : {}) },
    { timeoutMs: forwardTimeoutMs(method, params), signal: options.signal }
  )
  return { handled: true, result }
}

function forwardTimeoutMs(method: string, params: Record<string, unknown>): number {
  const requested = typeof params.timeout === 'number' ? params.timeout : 0
  const base = method === 'browser.wait' ? requested + WAIT_MARGIN_MS : DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(base, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
