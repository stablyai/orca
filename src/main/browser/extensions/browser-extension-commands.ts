import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  BrowserExtensionListParams,
  BrowserExtensionReloadParams,
  BrowserExtensionReloadResult,
  BrowserExtensionSummaryListResult,
  InstalledBrowserExtension
} from '../../../shared/browser/extensions/browser-extension-types'
import { BrowserError } from '../browser-error'
import { browserSessionRegistry } from '../sessions/browser-session-registry'
import { getBrowserExtensionInstallStore } from './installation/browser-extension-install-store'
import {
  listBrowserExtensionsForProfile,
  reloadUnpackedBrowserExtension
} from './browser-extension-management'

/** Finds the one installed unpacked extension whose canonical source folder is `path`. */
async function extensionIdForSourceFolder(
  path: string,
  installed: InstalledBrowserExtension[]
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new BrowserError('invalid_argument', 'Extension source folder must be an absolute path')
  }
  const directory = await realpath(path).catch(() => null)
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
  return ids[0]
}

/** Selection shape and ID format are checked by the RPC params schema. */
export const desktopBrowserExtensions = {
  async list({
    profileId = 'default'
  }: BrowserExtensionListParams): Promise<BrowserExtensionSummaryListResult> {
    if (!browserSessionRegistry.getProfile(profileId)) {
      throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
    }
    const { active, extensions } = await listBrowserExtensionsForProfile(profileId)
    return {
      active,
      extensions: extensions.map(({ id, name, version, source, path, enabled, loadError }) => ({
        id,
        name,
        version,
        source,
        path,
        enabled,
        loadError
      }))
    }
  },
  /** Reloads every profile where the extension is enabled, like the Settings reload button. */
  async reload(params: BrowserExtensionReloadParams): Promise<BrowserExtensionReloadResult> {
    const installed = getBrowserExtensionInstallStore().list()
    const extensionId =
      params.path !== undefined
        ? await extensionIdForSourceFolder(params.path, installed)
        : params.extensionId
    const extension = installed.find((record) => record.id === extensionId)
    if (!extension) {
      throw new BrowserError('invalid_argument', 'Extension is not installed')
    }
    if (extension.source !== 'unpacked') {
      throw new BrowserError('invalid_argument', 'Only unpacked extensions can be reloaded')
    }
    const result = await reloadUnpackedBrowserExtension(extension.id)
    if (!result.ok) {
      throw new BrowserError('runtime_error', result.error)
    }
    return { extensionId: extension.id }
  }
}
