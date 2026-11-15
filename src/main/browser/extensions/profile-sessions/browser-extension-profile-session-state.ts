import { retireBrowserExtensionExecution } from '../api-runtime/browser-extension-execution-authority'
import { removeBrowserExtensionFromSession } from './browser-extension-worker-registration'
import { recordBrowserExtensionLoadFailure } from './browser-extension-load-errors'
import {
  BROWSER_EXTENSION_PROFILE_UNAVAILABLE,
  throwIfBrowserExtensionLoadCancelled,
  type BrowserExtensionLoadAuthority,
  type BrowserExtensionProfileLoad,
  type BrowserExtensionProfileLoads
} from './browser-extension-profile-loads'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'

export type ProfileSessionState = {
  profile: BrowserSessionProfile
  session: Electron.Session
  /** Startup's sweep and loads; later loads wait for it. */
  loading: Promise<void>
  loads: BrowserExtensionProfileLoads
  started: Set<string>
  enabled: () => string[]
  /** Outstanding enable/install admissions; Disable revokes one before its next step. */
  enables: Map<string, BrowserExtensionEnableAdmission>
}

export type BrowserExtensionEnableAdmission = BrowserExtensionLoadAuthority & { revoke: () => void }

/** Per-session services and per-extension restart restore, supplied by browser-extension-startup. */
export type BrowserExtensionSessionHooks = {
  activating?: (sess: Electron.Session, ready: Promise<void>) => void
  attached: (sess: Electron.Session, profileId: string, enabledExtensionIds: string[]) => void
  /** Runs after each startup load; resolves when restored state is back in place. */
  loaded: (
    sess: Electron.Session,
    profileId: string,
    extension: Electron.Extension
  ) => Promise<void>
  /** Extensions turned off: undo what `attached` added to the request path. */
  detached: (sess: Electron.Session) => void
  reset?: (sess: Electron.Session, profileId: string, extensionId: string) => Promise<void>
  uninstalled: (profileId: string, extensionIds: ReadonlySet<string>) => void
}

export let sessionHooks: BrowserExtensionSessionHooks | null = null

export function setBrowserExtensionSessionHooks(hooks: BrowserExtensionSessionHooks): void {
  sessionHooks = hooks
}

export const stateByProfileId = new Map<string, ProfileSessionState>()

/** Admitted synchronously once the caller holds the extension lock, before its first wait. */
export function admitBrowserExtensionEnable(
  profileId: string,
  extensionId: string
): BrowserExtensionEnableAdmission {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  let revoked = false
  const admission: BrowserExtensionEnableAdmission = {
    get current() {
      return !revoked && stateByProfileId.get(profileId) === state
    },
    revoke: () => {
      revoked = true
      if (state.enables.get(extensionId) === admission) {
        state.enables.delete(extensionId)
      }
    }
  }
  state.enables.get(extensionId)?.revoke()
  state.enables.set(extensionId, admission)
  return admission
}

/** Disable needs no lock: it revokes an outstanding enable before that enable's next step. */
export function revokeBrowserExtensionEnable(profileId: string, extensionId: string): void {
  stateByProfileId.get(profileId)?.enables.get(extensionId)?.revoke()
}

/** A restoration failure retires only this target and remains visible to its explicit caller. */
export async function completeBrowserExtensionProfileLoad(
  state: ProfileSessionState,
  extension: Electron.Extension,
  load: BrowserExtensionProfileLoad
): Promise<void> {
  try {
    await sessionHooks?.loaded(state.session, state.profile.id, extension)
    throwIfBrowserExtensionLoadCancelled(load)
    state.started.add(extension.id)
  } catch (error) {
    recordBrowserExtensionLoadFailure(state.profile.id, extension.id, error)
    const retired = retireBrowserExtensionExecution(state.session, extension.id)
    if (state.session.extensions.getExtension(extension.id)) {
      removeBrowserExtensionFromSession(state.session, extension.id, 'suspend')
    }
    await retired
    throw error
  }
}
