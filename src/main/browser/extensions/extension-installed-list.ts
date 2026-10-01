import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserInstalledExtension } from '../../../shared/browser-guest-events'
import { extensionIconDataUrl } from './extension-action-state'
import { extensionOptionsUrl } from './extension-action-menu'
import {
  readDisabledExtensions,
  readInstalledExtensions,
  type InstalledExtension
} from './extension-install-folder'
import { browserExtensionSessions, browserExtensionsFolder } from './extension-sessions'

/** A manifest string, resolving `__MSG_name__` from the default locale as Chrome does. */
async function localized(install: InstalledExtension, value: unknown): Promise<string> {
  const text = typeof value === 'string' ? value : ''
  const key = /^__MSG_(\w+)__$/.exec(text)?.[1]
  const locale = install.manifest.default_locale
  if (!key || typeof locale !== 'string') {
    return text
  }
  try {
    const file = join(install.path, '_locales', locale, 'messages.json')
    const messages: unknown = JSON.parse(await readFile(file, 'utf8'))
    const entry = Object.entries(Object(messages)).find(
      ([name]) => name.toLowerCase() === key.toLowerCase()
    )
    const message: unknown = entry && Reflect.get(Object(entry[1]), 'message')
    return typeof message === 'string' ? message : text
  } catch {
    return text
  }
}

/** Every installed extension, turned on or off, for the browser settings. */
export async function listInstalledBrowserExtensions(): Promise<BrowserInstalledExtension[]> {
  const folder = browserExtensionsFolder()
  const [installs, disabled] = await Promise.all([
    readInstalledExtensions(folder),
    readDisabledExtensions(folder)
  ])
  const [session] = browserExtensionSessions()
  return Promise.all(
    installs.map(async (install) => {
      const manifest = install.manifest
      const loaded = session?.extensions.getExtension(install.id)
      const url = `chrome-extension://${install.id}/`
      return {
        id: install.id,
        name: loaded?.name ?? (await localized(install, manifest.name)),
        version: typeof manifest.version === 'string' ? manifest.version : '',
        description: await localized(install, manifest.description),
        iconDataUrl: extensionIconDataUrl(install, manifest.icons),
        enabled: !disabled.has(install.id),
        hasOptions: extensionOptionsUrl({ url, manifest }) !== null
      }
    })
  )
}
