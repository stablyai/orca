import { defineMethod } from '../core'
import { BrowserIdentitySet } from './browser-schemas'
import {
  getBrowserIdentityModeStatus,
  setBrowserIdentityMode
} from '../../../browser/browser-identity-mode-store'

// Why separate from browser-core: these read and write this host's own process identity rather
// than driving a page, so they take no BrowserTarget and never reach the runtime browser commands.
export const BROWSER_IDENTITY_METHODS = [
  defineMethod({
    name: 'browser.identity.get',
    params: null,
    handler: () => getBrowserIdentityModeStatus()
  }),
  defineMethod({
    name: 'browser.identity.set',
    params: BrowserIdentitySet,
    handler: async ({ mode, reset }) => setBrowserIdentityMode(mode, { reset })
  })
] as const
