import type { BrowserExtensionToolbarAction } from '../../../../shared/browser/extensions/browser-extension-toolbar-types'
import { resolveActionIconDataUrl } from './browser-extension-action-icon'
import { getBrowserExtensionActionState } from './browser-extension-action-registry'
import { browserExtensionColorToCss } from './browser-extension-action-state'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'

type ToolbarPage = { contents: Electron.WebContents; session: Electron.Session; profileId: string }

function manifestHasOptionsPage(extension: Electron.Extension): boolean {
  const manifest: { options_ui?: { page?: unknown }; options_page?: unknown } =
    extension.manifest ?? {}
  return typeof (manifest.options_ui?.page ?? manifest.options_page) === 'string'
}

export async function describeToolbarAction(
  page: ToolbarPage,
  extension: Electron.Extension,
  pinned: ReadonlySet<string>
): Promise<BrowserExtensionToolbarAction> {
  const installed = getBrowserExtensionInstallStore().get(extension.id)
  const details = getBrowserExtensionActionState(page.profileId, extension).get(page.contents.id)
  return {
    extensionId: extension.id,
    name: installed?.name ?? extension.name,
    title: details.title,
    iconDataUrl: await resolveActionIconDataUrl(extension.path, details.icon),
    badgeText: details.badgeText,
    badgeBackgroundColor: browserExtensionColorToCss(details.badgeBackgroundColor),
    badgeTextColor: browserExtensionColorToCss(details.badgeTextColor),
    enabled: details.enabled,
    hasPopup: details.popup !== '',
    pinned: pinned.has(extension.id),
    hasOptionsPage: manifestHasOptionsPage(extension),
    source: installed?.source ?? 'unpacked'
  }
}
