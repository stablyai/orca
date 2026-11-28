import { notShared, defineMethod } from '../../core'
import { callerTabPerson } from '../../../../bots/team-share/teammate-rules'
import {
  BrowserOpenUrlParams,
  BrowserTabCreateParams
} from '../../../../../shared/rpc-contract/browser/browser-tab-create-params'

// Opening a browser tab: a teammate's in their agent's Home goes to their own tab list.
export const BROWSER_TAB_CREATE_METHODS = [
  defineMethod({
    name: 'browser.tabCreate',
    ...notShared('workspace'),
    params: BrowserTabCreateParams,
    handler: async (params, { runtime, pairedDeviceId, clientKind, signal, callerScope }) =>
      runtime.createSessionBrowserTab(
        params,
        { pairedDeviceId, clientKind, signal },
        {
          person: callerTabPerson(callerScope)
        }
      )
  }),
  defineMethod({
    name: 'browser.openUrl',
    ...notShared('workspace'),
    params: BrowserOpenUrlParams,
    handler: async (params, { runtime, signal }) =>
      runtime.browserOpenUrlOnClient(params, { signal })
  })
]
