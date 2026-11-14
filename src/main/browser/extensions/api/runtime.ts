import { openBrowserExtensionOptionsPage } from '../tabs-and-windows/browser-extension-options-page'
import { placeBrowserExtensionCallerTab } from '../tabs-and-windows/browser-extension-agent-caller'
import { z } from 'zod'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../api-runtime/browser-extension-namespace-registry'

/** Only what Electron leaves unimplemented (lifecycle events: runtime-lifecycle); the rest is native. */
export function registerRuntimeNamespace(): void {
  registerBrowserExtensionNamespace('runtime', {
    methods: {
      openOptionsPage: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        openBrowserExtensionOptionsPage(
          caller.browserProfileId,
          caller.extension,
          placeBrowserExtensionCallerTab(caller, true)
        )
      )
    },
    events: ['onInstalled', 'onStartup']
  })
}
