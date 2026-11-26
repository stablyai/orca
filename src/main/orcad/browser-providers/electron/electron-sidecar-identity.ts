import { BROWSER_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus
} from '../../../../shared/browser/identity/browser-user-agent-mode'
import type { ElectronServeBrowserProcess } from './electron-serve-browser-process'
import type { RuntimeBrowserIdentity } from '../../../runtime/browser/installation/runtime-browser-commands-factory'

/** The sidecar's own setting fixes its pages' identity at launch, so orcad serves that one. */
export function electronSidecarIdentity(
  sidecar: Pick<ElectronServeBrowserProcess, 'sidecarWith'>
): RuntimeBrowserIdentity | null {
  // A temporary profile is deleted on stop, so a saved mode would never reach the next launch.
  const request = sidecar.sidecarWith(BROWSER_IDENTITY_RUNTIME_CAPABILITY, { persistent: true })
  if (!request) {
    return null
  }
  return {
    get: async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sidecar advertised browser.identity.v1, so it answers with that RPC's own result type.
      return (await request('browser.identity.get', undefined)) as BrowserIdentityModeStatus
    },
    set: async (mode, { reset }) => {
      const params = { mode, ...(reset ? { reset: true } : {}) }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, for browser.identity.set.
      return (await request('browser.identity.set', params)) as BrowserIdentityModeSetResult
    }
  }
}
