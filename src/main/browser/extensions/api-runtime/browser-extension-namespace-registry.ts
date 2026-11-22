import type { ZodType, output } from 'zod'

/**
 * Who is calling. Main derives this from the IPC sender frame or the worker protocol's session and
 * token, never from the payload, and only for an extension loaded in that session.
 */
export type BrowserExtensionCaller = {
  extension: Electron.Extension
  session: Electron.Session
  /** Local browser profile whose session loaded the extension. */
  browserProfileId: string
  /** Set for extension pages (tabs, popouts, popups). */
  webContents?: Electron.WebContents
  frame?: Electron.WebFrameMain
  /** Captured by the isolated preload when the page invokes the bridge. */
  userGesture?: boolean
  /** Set for calls from Orca's worker shim (the extension's service worker). */
  fromWorker?: boolean
}

/** Thrown by handlers; the message reaches the extension as the rejection / runtime.lastError. */
export class BrowserExtensionApiError extends Error {}

export type BrowserExtensionMethod = {
  invoke: (caller: BrowserExtensionCaller, rawArgs: unknown[]) => unknown
}

/** One permission, or any of several (declarativeNetRequest or its WithHostAccess form). */
export type BrowserExtensionNamespacePermission = string | readonly string[]

export type BrowserExtensionNamespace = {
  /** Manifest permission the caller must declare; omit for always-available namespaces. */
  permission?: BrowserExtensionNamespacePermission
  methods: Record<string, BrowserExtensionMethod>
  /** Event names (e.g. 'onCreated') main may emit through emitBrowserExtensionEvent. */
  events: readonly string[]
}

/**
 * Declares one method. `params` validates the whole argument tuple as the extension sent it
 * (callbacks already stripped by the preload), so handlers only ever see checked values.
 */
export function defineBrowserExtensionMethod<Params extends ZodType<unknown[]>>(
  params: Params,
  handle: (caller: BrowserExtensionCaller, ...args: output<Params>) => unknown
): BrowserExtensionMethod {
  return {
    invoke: (caller, rawArgs) => {
      const parsed = params.safeParse(rawArgs)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
        throw new BrowserExtensionApiError(`Invalid arguments${where}: ${issue?.message ?? ''}`)
      }
      return handle(caller, ...parsed.data)
    }
  }
}

const namespaces = new Map<string, BrowserExtensionNamespace>()

/** Wave 2+ adds an API by registering here and listing it in the preload's API surface. */
export function registerBrowserExtensionNamespace(
  name: string,
  namespace: BrowserExtensionNamespace
): void {
  namespaces.set(name, namespace)
}

export function getBrowserExtensionNamespace(name: string): BrowserExtensionNamespace | null {
  return namespaces.get(name) ?? null
}

export function listBrowserExtensionNamespaces(): [string, BrowserExtensionNamespace][] {
  return [...namespaces.entries()]
}

type GrantedPermissionsLookup = (
  extension: Electron.Extension,
  session: Electron.Session
) => readonly string[]

let grantedPermissionsLookup: GrantedPermissionsLookup | null = null

/** permissions.ts supplies optional permissions the user granted in a profile. */
export function setBrowserExtensionGrantedPermissionsLookup(
  lookup: GrantedPermissionsLookup
): void {
  grantedPermissionsLookup = lookup
}

/** Declared in the manifest, or (given the session) granted through permissions.request. */
export function extensionHasPermission(
  extension: Electron.Extension,
  permission: string,
  session?: Electron.Session
): boolean {
  const declared: unknown = extension.manifest?.permissions
  if (Array.isArray(declared) && declared.includes(permission)) {
    return true
  }
  return Boolean(session && grantedPermissionsLookup?.(extension, session).includes(permission))
}

export function extensionHasNamespacePermission(
  extension: Electron.Extension,
  permission: BrowserExtensionNamespacePermission | undefined,
  session?: Electron.Session
): boolean {
  return (
    permission === undefined ||
    [permission].flat().some((name) => extensionHasPermission(extension, name, session))
  )
}
