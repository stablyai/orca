import { z } from 'zod'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  setBrowserExtensionGrantedPermissionsLookup,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  browserExtensionHostPatterns,
  containsBrowserExtensionPermissions,
  effectiveBrowserExtensionPermissions,
  planBrowserExtensionPermissionRemoval,
  planBrowserExtensionPermissionRequest,
  withGrantedPermissions,
  withoutGrantedPermissions,
  type BrowserExtensionPermissionSet
} from '../browser-extension-permission-grants'
import { askToGrantBrowserExtensionPermissions } from '../browser-extension-permission-prompt'
import { getBrowserExtensionProfileStateStore } from '../browser-extension-profile-state-store'
import { getHostSessionState } from '../browser-extension-contexts'
import { getBrowserExtensionContextSignal } from '../browser-extension-context-lifetime'
import { getDnrSessionRuntime } from '../browser-extension-dnr-session'
import { observeBrowserExtensionWebRequests } from '../browser-extension-web-request'

const USER_GESTURE_WINDOW_MS = 5_000
const recentGestures = new WeakMap<
  Electron.Session,
  Map<string, { at: number; signal: AbortSignal }>
>()
const pendingRequests = new Set<string>()

const permissionsSchema = z
  .object({ permissions: z.array(z.string()), origins: z.array(z.string()) })
  .partial()
  .loose()

function gestureKey(profileId: string, extensionId: string): string {
  return `${profileId}\n${extensionId}`
}

/**
 * Chrome lets permissions.request run only inside a user gesture. Orca records the gestures it
 * delivers to an extension (menu click, command, notification click, toolbar click).
 */
export function noteBrowserExtensionUserGesture(
  session: Electron.Session,
  extensionId: string
): void {
  const state = getHostSessionState(session)
  if (!state) {
    return
  }
  const signal = getBrowserExtensionContextSignal(state, extensionId)
  let gestures = recentGestures.get(session)
  if (!gestures) {
    gestures = new Map()
    recentGestures.set(session, gestures)
  }
  gestures.set(extensionId, { at: Date.now(), signal })
}

export function hasBrowserExtensionUserGesture(caller: BrowserExtensionCaller): boolean {
  if (caller.userGesture === true) {
    return true
  }
  const gesture = recentGestures.get(caller.session)?.get(caller.extension.id)
  return (
    gesture !== undefined &&
    !gesture.signal.aborted &&
    Date.now() - gesture.at <= USER_GESTURE_WINDOW_MS
  )
}

function readGrants(profileId: string, extensionId: string) {
  return getBrowserExtensionProfileStateStore().read(profileId, extensionId)
}

/** Manifest host patterns plus origins the user granted in this session's profile. */
export function browserExtensionHostPatternsInSession(
  extension: Electron.Extension,
  session: Electron.Session
): string[] {
  const profileId = getBrowserExtensionProfileIdForSession(session)
  const grants = profileId
    ? readGrants(profileId, extension.id)
    : { grantedPermissions: [], grantedOrigins: [] }
  return browserExtensionHostPatterns(extension.manifest, grants)
}

function emitChange(
  caller: BrowserExtensionCaller,
  event: 'onAdded' | 'onRemoved',
  change: BrowserExtensionPermissionSet
): void {
  if (change.permissions.length === 0 && change.origins.length === 0) {
    return
  }
  emitBrowserExtensionEvent(
    { session: caller.session, extensionId: caller.extension.id },
    'permissions',
    event,
    [change]
  )
}

async function request(
  caller: BrowserExtensionCaller,
  wanted: Partial<BrowserExtensionPermissionSet>
): Promise<boolean> {
  const { extension, browserProfileId } = caller
  const plan = planBrowserExtensionPermissionRequest(
    extension.manifest,
    readGrants(browserProfileId, extension.id),
    wanted
  )
  if (plan.kind === 'invalid') {
    throw new BrowserExtensionApiError(plan.error)
  }
  if (plan.kind === 'already-granted') {
    return true
  }
  if (!hasBrowserExtensionUserGesture(caller)) {
    throw new BrowserExtensionApiError('This function must be called during a user gesture')
  }
  const key = gestureKey(browserProfileId, extension.id)
  if (pendingRequests.has(key)) {
    throw new BrowserExtensionApiError('A permissions request is already pending')
  }
  const state = getHostSessionState(caller.session)
  if (!state) {
    return false
  }
  const signal = getBrowserExtensionContextSignal(state, extension.id)
  pendingRequests.add(key)
  try {
    const accepted = await askToGrantBrowserExtensionPermissions(
      browserProfileId,
      extension,
      plan.add,
      signal
    )
    if (!accepted || signal.aborted) {
      return false
    }
    getBrowserExtensionProfileStateStore().update(browserProfileId, extension.id, (state) =>
      withGrantedPermissions(state, plan.add)
    )
    if (plan.add.permissions.includes('webRequest')) {
      observeBrowserExtensionWebRequests(caller.session)
    }
    await getDnrSessionRuntime(caller.session)?.reconcilePermissions(extension)
    emitChange(caller, 'onAdded', plan.add)
    return true
  } finally {
    pendingRequests.delete(key)
  }
}

async function remove(
  caller: BrowserExtensionCaller,
  wanted: Partial<BrowserExtensionPermissionSet>
): Promise<boolean> {
  const { extension, browserProfileId } = caller
  const plan = planBrowserExtensionPermissionRemoval(
    extension.manifest,
    readGrants(browserProfileId, extension.id),
    wanted
  )
  if (plan.kind === 'invalid') {
    throw new BrowserExtensionApiError(plan.error)
  }
  getBrowserExtensionProfileStateStore().update(browserProfileId, extension.id, (state) =>
    withoutGrantedPermissions(state, plan.removed)
  )
  await getDnrSessionRuntime(caller.session)?.reconcilePermissions(extension)
  emitChange(caller, 'onRemoved', plan.removed)
  return true
}

export function registerPermissionsNamespace(): void {
  setBrowserExtensionGrantedPermissionsLookup((extension, session) => {
    const profileId = getBrowserExtensionProfileIdForSession(session)
    return profileId ? readGrants(profileId, extension.id).grantedPermissions : []
  })
  registerBrowserExtensionNamespace('permissions', {
    methods: {
      contains: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), (caller, wanted) =>
        containsBrowserExtensionPermissions(
          caller.extension.manifest,
          readGrants(caller.browserProfileId, caller.extension.id),
          wanted
        )
      ),
      getAll: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        effectiveBrowserExtensionPermissions(
          caller.extension.manifest,
          readGrants(caller.browserProfileId, caller.extension.id)
        )
      ),
      request: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), request),
      remove: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), remove)
    },
    events: ['onAdded', 'onRemoved']
  })
}
