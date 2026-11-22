import { BROWSER_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus
} from '../../../../shared/browser/identity/browser-user-agent-mode'
import type { ElectronServeBrowserProcess } from './electron-serve-browser-process'
import type { RuntimeBrowserIdentity } from '../../../runtime/browser/installation/runtime-browser-commands-factory'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'

/** The sidecar's own setting fixes its pages' identity at launch, so orcad serves that one. */
export function electronSidecarIdentity(
  sidecar: Pick<ElectronServeBrowserProcess, 'sidecarWith'>
): RuntimeBrowserIdentity | null {
  // A temporary profile is deleted on stop, so a saved mode would never reach the next launch.
  const metadata = sidecar.sidecarWith(BROWSER_IDENTITY_RUNTIME_CAPABILITY, { persistent: true })
  if (!metadata) {
    return null
  }
  return {
    get: async () =>
      (await sendOrcadSidecarRequest(
        metadata,
        'browser.identity.get',
        undefined
      )) as BrowserIdentityModeStatus,
    set: async (mode, { reset }) =>
      (await sendOrcadSidecarRequest(metadata, 'browser.identity.set', {
        mode,
        ...(reset ? { reset: true } : {})
      })) as BrowserIdentityModeSetResult
  }
}
