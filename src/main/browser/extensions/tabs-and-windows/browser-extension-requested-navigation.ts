import { resolveBrowserExtensionRequestedUrl } from '../../../../shared/browser/extensions/browser-extension-url'
import {
  BrowserExtensionApiError,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'

/** Resolves an extension-requested URL through Orca's rules; extension pages must be loaded in `sess`. */
export function requireOpenableUrl(
  caller: BrowserExtensionCaller,
  rawUrl: string | undefined,
  sess: Electron.Session
): string {
  const resolved = resolveBrowserExtensionRequestedUrl(rawUrl, caller.extension.id)
  if (
    !resolved ||
    (resolved.kind === 'extension' && !sess.extensions.getExtension(resolved.extensionId))
  ) {
    throw new BrowserExtensionApiError(`Cannot open URL: ${rawUrl ?? ''}`)
  }
  return resolved.url
}
