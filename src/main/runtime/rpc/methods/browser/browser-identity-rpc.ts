import { defineMethod } from '../../core'
import { BrowserIdentitySet } from '../../../../../shared/rpc-contract/browser/browser-identity-params'
import {
  getBrowserIdentityModeStatus,
  setBrowserIdentityMode
} from '../../../../browser/identity/mode/browser-identity-mode-store'
import { clientHostedPagesSettingsNote } from '../../../browser/client-pages/client-hosted-pages-settings-note'

// Process identity has no BrowserTarget and does not drive pages, so keep it separate from browser-core.
export const BROWSER_IDENTITY_METHODS = [
  defineMethod({
    name: 'browser.identity.get',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({
      ...getBrowserIdentityModeStatus(),
      ...clientHostedPagesSettingsNote(runtime, 'identity')
    })
  }),
  defineMethod({
    name: 'browser.identity.set',
    permission: 'workspace',
    params: BrowserIdentitySet,
    handler: async ({ mode, reset }, { runtime }) => {
      const result = await setBrowserIdentityMode(mode, { reset })
      return result.ok
        ? { ...result, ...clientHostedPagesSettingsNote(runtime, 'identity') }
        : result
    }
  })
] as const
