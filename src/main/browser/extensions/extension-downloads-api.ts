import { handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { extensionUrl, objectArg } from './extension-api-args'
import { lastExtensionTab } from './extension-tab-registry'

let nextDownloadId = 1

handleExtensionApi('downloads', {
  // Why through a tab: Orca's download flow (save prompt, progress) belongs to a browser page.
  download: (caller: ExtensionCaller, options: unknown) => {
    const tab = lastExtensionTab()
    if (!tab || tab.session !== caller.session) {
      throw new Error('No browser tab to download in')
    }
    tab.downloadURL(extensionUrl(caller.extension, objectArg(options).url))
    return nextDownloadId++
  }
})
