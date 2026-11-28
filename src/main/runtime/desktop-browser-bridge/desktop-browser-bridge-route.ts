/** Only orcad-local CLI browser calls forward to desktops; paired clients must never bounce back. */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { BrowserError } from '../../browser/browser-error'
import { assertUploadFilesExist } from '../../browser/cdp/input/browser-upload-files'
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_TAB_CREATE_FOCUS_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE,
  isDesktopBrowserBridgeMethod
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { BROWSER_EXPECT_URL_UNSUPPORTED_CODE } from '../../../shared/browser/client-hosting/browser-expected-url'
import { browserWaitRequestTimeoutMs } from '../../../shared/browser/automation/browser-wait-timeout'
import type { RpcCallerIdentity } from '../rpc/callers/rpc-caller-identity'
import { assertClientOpenableUrl } from '../browser/client-pages/browser-client-page-opening'
import type { DesktopBrowserBridgeRegistry } from './desktop-browser-bridge-registry'

export type DesktopBrowserBridgeRoute = { handled: false } | { handled: true; result: unknown }

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 10 * 60_000
const DOWNLOAD_TIMEOUT_MS = 65_000

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
  // Never fall back to this host's own browser: goto and click act on the desktop tab.
  if (!forwarded) {
    throw new BrowserError(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${notForwardedReason(method)} Nothing ran in this host's own browser.`
    )
  }
  const params: Record<string, unknown> = isRecord(options.params) ? { ...options.params } : {}
  if (forwardedMethod === 'browser.tabCreate' && params.profileId !== undefined) {
    throw new BrowserError(
      'invalid_argument',
      'tab create --profile is not available from an SSH host; the desktop picks the profile for new tabs. Drop --profile, or open the tab on the desktop.'
    )
  }
  // Every later command goes to the desktop, so a tab in this host's own browser would be unreachable.
  if (forwardedMethod === 'browser.tabCreate' && params.placement !== undefined) {
    throw new BrowserError(
      'invalid_argument',
      'tab create --headless is not available while an Orca desktop shares its browser with this host; browser commands go to that desktop. Drop --headless.'
    )
  }
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
  const hostFiles = await hostFileTransfer(forwardedMethod, params)
  // After every await: forward picks the newest attachment, which may have changed by now.
  if (params.expectUrl !== undefined && !options.registry.newestAttachmentEnforcesExpectUrl()) {
    throw new BrowserError(
      BROWSER_EXPECT_URL_UNSUPPORTED_CODE,
      'The Orca desktop sharing its browser cannot check --expect-url. Update Orca on that desktop or drop the flag.'
    )
  }
  // Refused, not dropped: an older desktop would open the tab behind the visible one.
  if (
    forwardedMethod === 'browser.tabCreate' &&
    params.activate === true &&
    !options.registry.newestAttachmentDeclares(DESKTOP_BROWSER_BRIDGE_TAB_CREATE_FOCUS_CAPABILITY)
  ) {
    throw new BrowserError(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      'The Orca desktop sharing its browser is too old to bring a new tab to the front. Update Orca on that desktop or drop --focus.'
    )
  }
  if (!options.registry.newestAttachmentServes(forwardedMethod)) {
    throw new BrowserError(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `The Orca desktop sharing its browser is too old to run ${method} for this host. Update Orca on that desktop.`
    )
  }
  const result = await options.registry.forward(
    {
      method: forwardedMethod,
      params,
      ...(workspaceId ? { workspaceId } : {}),
      ...hostFiles
    },
    { timeoutMs: forwardTimeoutMs(forwardedMethod, params), signal: options.signal }
  )
  return { handled: true, result }
}

// The desktop never sees a path on this host: it reads named files from orcad and streams downloads back.
async function hostFileTransfer(
  method: string,
  params: Record<string, unknown>
): Promise<{ readablePaths?: string[]; downloadPath?: string }> {
  if (method === 'browser.upload') {
    const files: unknown[] = Array.isArray(params.files) ? params.files : []
    const paths = files.filter((file): file is string => typeof file === 'string')
    const relative = files.find((file) => typeof file !== 'string' || !path.isAbsolute(file))
    if (relative !== undefined) {
      throw new BrowserError(
        'invalid_argument',
        `Cannot upload ${String(relative)}: use an absolute path`
      )
    }
    // Same refusal as a local upload, before the desktop is asked for anything.
    await assertUploadFilesExist(paths)
    for (const file of paths) {
      if ((await stat(file)).isDirectory()) {
        throw new BrowserError(
          'invalid_argument',
          `Cannot upload ${file}: a desktop tab can only take files from an SSH host, not folders`
        )
      }
    }
    return { readablePaths: paths }
  }
  if (method !== 'browser.download') {
    return {}
  }
  const downloadPath = params.path
  if (typeof downloadPath !== 'string' || !path.isAbsolute(downloadPath)) {
    throw new BrowserError(
      'invalid_argument',
      `--path must be an absolute path: ${String(downloadPath)}`
    )
  }
  delete params.path
  return { downloadPath }
}

function forwardTimeoutMs(method: string, params: Record<string, unknown>): number {
  if (method === 'browser.download') {
    // The desktop answers by its 50 s download deadline; leave that room inside its own deadline.
    return DOWNLOAD_TIMEOUT_MS
  }
  return method === 'browser.wait'
    ? Math.min(browserWaitRequestTimeoutMs(params.timeout), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
}

function notForwardedReason(method: string): string {
  if (
    method.startsWith('browser.cookie.') ||
    method.startsWith('browser.intercept.') ||
    method.startsWith('browser.capture.') ||
    method === 'browser.setHeaders' ||
    method === 'browser.setCredentials'
  ) {
    return "An SSH host can't read or change the desktop browser's cookies, request headers or credentials."
  }
  if (method === 'browser.clipboardRead') {
    return "An SSH host can't read the desktop clipboard."
  }
  if (method === 'browser.clipboardWrite') {
    return "An SSH host can't use the desktop clipboard. Use orca type or orca fill instead."
  }
  if (method === 'browser.exec') {
    return "An SSH host can't run raw agent-browser commands on the desktop. Use the named orca browser commands instead."
  }
  if (method === 'browser.certificate.proceed') {
    return 'Only someone at the desktop can accept a certificate warning in its browser.'
  }
  if (method.startsWith('browser.identity.')) {
    return 'Browser identity is a setting of the Orca desktop that shares its browser with this host. Change it there in Settings › Browser.'
  }
  if (/^browser\.(profile|tabProfile|tabSetProfile)/.test(method)) {
    return 'Browser profiles belong to the Orca desktop that shares its browser with this host. Pick or change them there.'
  }
  if (method.startsWith('browser.extension')) {
    return 'Browser extensions belong to the Orca desktop that shares its browser with this host. Manage them there.'
  }
  return `${method} is not available from an SSH host.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
