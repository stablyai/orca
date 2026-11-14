import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'
import { openBrowserExtensionTab } from './browser-extension-tab-model'
import type { BrowserExtensionTabPlacement } from './browser-extension-agent-caller'

function optionsPagePath(extension: Electron.Extension): string | null {
  const manifest: { options_ui?: { page?: unknown }; options_page?: unknown } =
    extension.manifest ?? {}
  const page = manifest.options_ui?.page ?? manifest.options_page
  return typeof page === 'string' && page.length > 0 ? page : null
}

/** Opens the extension's options page as an Orca tab in the given browser profile. */
export async function openBrowserExtensionOptionsPage(
  browserProfileId: string,
  extension: Electron.Extension,
  placement: BrowserExtensionTabPlacement
): Promise<void> {
  const page = optionsPagePath(extension)
  if (!page) {
    throw new BrowserExtensionApiError('This extension has no options page')
  }
  const url = new URL(page.replace(/^\/+/, ''), `${getChromeExtensionOrigin(extension.id)}/`)
  await openBrowserExtensionTab(browserProfileId, url.toString(), placement)
}
