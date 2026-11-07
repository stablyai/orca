import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  BrowserExtensionListParams,
  BrowserExtensionReloadParams,
  BrowserExtensionReloadResult
} from '../../../shared/browser/extensions/browser-extension-types'
import { isChromeExtensionId } from '../../../shared/browser/extensions/browser-extension-url'
import { BrowserError } from '../browser-error'
import { browserSessionRegistry } from '../sessions/browser-session-registry'
import { getBrowserExtensionInstallStore } from './installation/browser-extension-install-store'
import {
  listBrowserExtensionsForProfile,
  reloadUnpackedBrowserExtension
} from './browser-extension-management'

function requireProfile({ profileId = 'default' }: BrowserExtensionListParams): string {
  if (!browserSessionRegistry.getProfile(profileId)) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return profileId
}

export const desktopBrowserExtensions = {
  async list(params: BrowserExtensionListParams) {
    return listBrowserExtensionsForProfile(requireProfile(params))
  },
  async reload(params: BrowserExtensionReloadParams): Promise<BrowserExtensionReloadResult> {
    requireProfile(params)
    if ((params.extensionId === undefined) === (params.path === undefined)) {
      throw new BrowserError('invalid_argument', 'Pass either an extension ID or --path <folder>')
    }
    const installed = getBrowserExtensionInstallStore().list()
    let extensionId = params.extensionId
    if (params.path !== undefined) {
      if (!isAbsolute(params.path)) {
        throw new BrowserError(
          'invalid_argument',
          'Extension source folder must be an absolute path'
        )
      }
      const directory = await realpath(params.path).catch(() => null)
      if (!directory || !(await stat(directory).catch(() => null))?.isDirectory()) {
        throw new BrowserError('invalid_argument', 'Extension source folder was not found')
      }
      const matches = await Promise.all(
        installed
          .filter((extension) => extension.source === 'unpacked')
          .map(async (extension) =>
            (await realpath(extension.path).catch(() => null)) === directory ? extension.id : null
          )
      )
      const ids = matches.filter((id) => id !== null)
      if (ids.length !== 1) {
        throw new BrowserError(
          'invalid_argument',
          ids.length === 0
            ? 'No installed unpacked extension matches this source folder'
            : 'Multiple installed unpacked extensions match this source folder; use an extension ID'
        )
      }
      extensionId = ids[0]
    }
    if (!extensionId || !isChromeExtensionId(extensionId)) {
      throw new BrowserError('invalid_argument', 'Invalid Chrome extension ID')
    }
    const extension = installed.find((record) => record.id === extensionId)
    if (!extension) {
      throw new BrowserError('invalid_argument', 'Extension is not installed')
    }
    if (extension.source !== 'unpacked') {
      throw new BrowserError('invalid_argument', 'Only unpacked extensions can be reloaded')
    }
    const result = await reloadUnpackedBrowserExtension(extensionId)
    if (!result.ok) {
      throw new BrowserError('runtime_error', result.error)
    }
    return { extensionId, scope: 'enabled-profiles' }
  }
}
