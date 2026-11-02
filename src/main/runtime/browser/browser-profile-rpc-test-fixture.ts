import '../rpc/unused-default-rpc-methods.test-fixture'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from '../rpc/dispatcher'
import { BROWSER_PROFILE_METHODS } from '../rpc/methods/browser-profile-rpc-methods'
import { RuntimeBrowserProfiles } from './browser-profiles'

export function browserProfileRpcFixture(executorRuntimeId: string, outerRuntimeId = 'D') {
  const unavailable = () => {
    throw new Error('unused page target')
  }
  const profiles = new RuntimeBrowserProfiles(
    {
      getRuntimeId: () => executorRuntimeId,
      getAuthoritativeWindow: unavailable,
      getRuntimeBrowserPageRegistry: unavailable,
      getBrowserHostLeaseRegistry: unavailable
    },
    { requireAgentBrowserBridge: unavailable, resolveBrowserCommandTarget: async () => ({}) },
    { describeBrowserTab: unavailable, resolveClientHostedBrowserPage: async () => undefined }
  )
  const runtime = new OrcaRuntimeService(null)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue(outerRuntimeId)
  vi.spyOn(runtime, 'browserProfileList').mockImplementation(() => profiles.browserProfileList())
  vi.spyOn(runtime, 'browserProfileImportFromBrowser').mockImplementation(
    profiles.browserProfileImportFromBrowser.bind(profiles)
  )
  vi.spyOn(runtime, 'browserProfileClearGoogleCookies').mockImplementation(
    profiles.browserProfileClearGoogleCookies.bind(profiles)
  )
  return { profiles, dispatcher: new RpcDispatcher({ runtime, methods: BROWSER_PROFILE_METHODS }) }
}
