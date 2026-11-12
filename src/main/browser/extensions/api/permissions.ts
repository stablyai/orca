import { readBrowserExtensionProfileGrants } from '../permissions/browser-extension-session-permissions'
import { hasBrowserExtensionUserGesture } from '../permissions/browser-extension-user-gesture'
import { z } from 'zod'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from '../api-runtime/browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  setBrowserExtensionGrantedPermissionsLookup,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import {
  containsBrowserExtensionPermissions,
  effectiveBrowserExtensionPermissions,
  planBrowserExtensionPermissionRemoval,
  planBrowserExtensionPermissionRequest,
  withGrantedPermissions,
  withoutGrantedPermissions,
  type BrowserExtensionPermissionSet
} from '../permissions/browser-extension-permission-grants'
import { askToGrantBrowserExtensionPermissions } from '../permissions/browser-extension-permission-prompt'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import { getHostSessionState } from '../api-runtime/browser-extension-contexts'
import { getBrowserExtensionContextSignal } from '../api-runtime/browser-extension-context-lifetime'
import { getDnrSessionRuntime } from '../declarative-net-request/session/browser-extension-dnr-session'
import { observeBrowserExtensionWebRequests } from '../requests/browser-extension-web-request-observer'

const pendingRequests = new Set<string>()

const permissionsSchema = z
  .object({ permissions: z.array(z.string()), origins: z.array(z.string()) })
  .partial()
  .loose()

function gestureKey(profileId: string, extensionId: string): string {
  return `${profileId}\n${extensionId}`
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
    readBrowserExtensionProfileGrants(browserProfileId, extension.id),
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
    readBrowserExtensionProfileGrants(browserProfileId, extension.id),
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
    return profileId
      ? readBrowserExtensionProfileGrants(profileId, extension.id).grantedPermissions
      : []
  })
  registerBrowserExtensionNamespace('permissions', {
    methods: {
      contains: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), (caller, wanted) =>
        containsBrowserExtensionPermissions(
          caller.extension.manifest,
          readBrowserExtensionProfileGrants(caller.browserProfileId, caller.extension.id),
          wanted
        )
      ),
      getAll: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        effectiveBrowserExtensionPermissions(
          caller.extension.manifest,
          readBrowserExtensionProfileGrants(caller.browserProfileId, caller.extension.id)
        )
      ),
      request: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), request),
      remove: defineBrowserExtensionMethod(z.tuple([permissionsSchema]), remove)
    },
    events: ['onAdded', 'onRemoved']
  })
}
