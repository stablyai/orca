import { openBrowserExtensionOptionsPage } from '../tabs-and-windows/browser-extension-options-page'
import { placeBrowserExtensionCallerTab } from '../tabs-and-windows/browser-extension-agent-caller'
import { z } from 'zod'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../api-runtime/browser-extension-namespace-registry'
import {
  browserExtensionContextFilterSchema,
  listBrowserExtensionSidePanelContexts
} from '../side-panel/browser-extension-side-panel-contexts'

/** Only what Electron leaves unimplemented or can't see (side panels); the rest is native. */
export function registerRuntimeNamespace(): void {
  registerBrowserExtensionNamespace('runtime', {
    methods: {
      openOptionsPage: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        openBrowserExtensionOptionsPage(
          caller.browserProfileId,
          caller.extension,
          placeBrowserExtensionCallerTab(caller, true)
        )
      ),
      getContexts: defineBrowserExtensionMethod(
        // Why optional: MV2 pages have no native getContexts to answer first.
        z.tuple([browserExtensionContextFilterSchema, z.array(z.unknown()).optional()]),
        (caller, filter, nativeContexts) => [
          ...(nativeContexts ?? []),
          ...listBrowserExtensionSidePanelContexts(
            caller.browserProfileId,
            caller.extension.id,
            filter
          )
        ]
      )
    },
    events: ['onInstalled', 'onStartup']
  })
}
