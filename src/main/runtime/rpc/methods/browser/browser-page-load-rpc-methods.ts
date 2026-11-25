import { defineMethod } from '../../core'
import { BrowserTarget } from '../../../../../shared/rpc-contract/rpc-param-primitives'
import { Reload } from '../../../../../shared/rpc-contract/browser/browser-core-params'

export const BROWSER_PAGE_LOAD_METHODS = [
  defineMethod({
    name: 'browser.reload',
    permission: 'workspace',
    share: 'not-shared',
    params: Reload,
    handler: async (params, { runtime }) => runtime.browserReload(params)
  }),
  defineMethod({
    name: 'browser.stop',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStop(params)
  })
]
