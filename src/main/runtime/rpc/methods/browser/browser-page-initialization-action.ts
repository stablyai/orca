import { BrowserPageInitializationActionParams } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import { projectSessionTabsForClient } from '../session-tabs/session-tabs-client-projection'
import { defineMethod } from '../../core'

export const BROWSER_PAGE_INITIALIZATION_ACTION_METHODS = [
  defineMethod({
    name: 'browser.clientPage.initializationAction',
    permission: 'workspace',
    params: BrowserPageInitializationActionParams,
    handler: async (params, { runtime, pairedDeviceId, clientKind, clientCapabilities }) => {
      await runtime.actOnClientPageInitialization(params)
      const snapshot = projectSessionTabsForClient(
        await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId, {
          includeInitialSurfaceLaunch: true,
          includeAgentSenders: clientKind !== 'mobile'
        }),
        clientKind,
        clientCapabilities
      )
      runtime.observeClientHostedPageSnapshots?.([snapshot], pairedDeviceId)
      return snapshot
    }
  })
]
