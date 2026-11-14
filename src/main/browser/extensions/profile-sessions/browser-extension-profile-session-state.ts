import { retireBrowserExtensionExecution } from '../api-runtime/browser-extension-execution-authority'
import { removeBrowserExtensionFromSession } from './browser-extension-worker-registration'
import { recordBrowserExtensionLoadFailure } from './browser-extension-load-errors'
import {
  throwIfBrowserExtensionLoadCancelled,
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
}

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
