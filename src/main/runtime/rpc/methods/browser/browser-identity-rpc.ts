import { defineMethod } from '../../core'
import { BrowserIdentitySet } from '../../../../../shared/rpc-contract/browser/browser-identity-params'
import {
  getBrowserIdentityModeStatus,
  isBrowserIdentityModeStoreInitialized,
  setBrowserIdentityMode
} from '../../../../browser/identity/mode/browser-identity-mode-store'
import { clientHostedPagesSettingsNote } from '../../../browser/client-pages/client-hosted-pages-settings-note'
import { BrowserError } from '../../../../browser/browser-error'
import {
  runtimeBrowserEngineIdentity,
  type RuntimeBrowserIdentity
} from '../../../browser/installation/runtime-browser-commands-factory'

const localIdentity: RuntimeBrowserIdentity = {
  get: async () => getBrowserIdentityModeStatus(),
  set: setBrowserIdentityMode
}

function hostIdentity(): RuntimeBrowserIdentity {
  if (isBrowserIdentityModeStoreInitialized()) {
    return localIdentity
  }
  const engine = runtimeBrowserEngineIdentity()
  if (!engine) {
    throw new BrowserError(
      'browser_identity_unavailable',
      "This host's browser has no identity setting."
    )
  }
  return engine
}

// Process identity has no BrowserTarget and does not drive pages, so keep it separate from browser-core.
export const BROWSER_IDENTITY_METHODS = [
  defineMethod({
    name: 'browser.identity.get',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      ...(await hostIdentity().get()),
      ...clientHostedPagesSettingsNote(runtime, 'identity')
    })
  }),
  defineMethod({
    name: 'browser.identity.set',
    permission: 'workspace',
    params: BrowserIdentitySet,
    handler: async ({ mode, reset }, { runtime }) => {
      const result = await hostIdentity().set(mode, { reset })
      return result.ok
        ? { ...result, ...clientHostedPagesSettingsNote(runtime, 'identity') }
        : result
    }
  })
] as const
