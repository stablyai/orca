import { defineMethod } from '../../core'
import { TabShow } from '../../../../../shared/rpc-contract/browser/browser-params'
import { BrowserError } from '../../../../browser/browser-error'

export const BROWSER_TAB_CDP_METHODS = [
  defineMethod({
    name: 'browser.tabCdp',
    permission: 'workspace',
    params: TabShow,
    handler: async (params, { runtime, caller }) => {
      // The endpoint is a loopback URL that skips per-action guards: only this host's own CLI gets it.
      if (caller?.kind !== 'local-cli') {
        throw new BrowserError(
          'invalid_argument',
          'orca tab cdp is available only to the local orca CLI'
        )
      }
      return runtime.browserTabCdp(params)
    }
  })
]
