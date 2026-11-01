import { defineMethod } from '../core'
import { BrowserIdentitySet } from '../../../../shared/rpc-contract/browser-identity-params'
import {
  getBrowserIdentityModeStatus,
  setBrowserIdentityMode
} from '../../../browser/browser-identity-mode-store'

// Process identity has no BrowserTarget and does not drive pages, so keep it separate from browser-core.
export const BROWSER_IDENTITY_METHODS = [
  defineMethod({
    name: 'browser.identity.get',
    permission: 'workspace',
    params: null,
    handler: () => getBrowserIdentityModeStatus()
  }),
  defineMethod({
    name: 'browser.identity.set',
    permission: 'workspace',
    params: BrowserIdentitySet,
    handler: async ({ mode, reset }) => setBrowserIdentityMode(mode, { reset })
  })
] as const
