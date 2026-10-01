import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { objectArg, stringArg } from './extension-api-args'
import { listBrowserExtensionCommands } from './extension-commands'

// Optional permissions an extension was granted this run, by extension id.
const granted = new Map<string, Set<string>>()

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((each): each is string => typeof each === 'string')
    : []
}

function declared(extension: Electron.Extension, key: string): string[] {
  return strings(extension.manifest[key])
}

/** Required permissions and host permissions, plus optional ones granted since load. */
function currentPermissions(extension: Electron.Extension): Set<string> {
  return new Set([
    ...declared(extension, 'permissions'),
    ...declared(extension, 'host_permissions'),
    ...(granted.get(extension.id) ?? [])
  ])
}

function requested(details: unknown): string[] {
  const args = objectArg(details)
  return [...strings(args.permissions), ...strings(args.origins)]
}

function permissionsObject(names: Iterable<string>) {
  const all = [...names]
  const isOrigin = (name: string) => name === '<all_urls>' || name.includes('://')
  return { permissions: all.filter((name) => !isOrigin(name)), origins: all.filter(isOrigin) }
}

handleExtensionApi('permissions', {
  contains: (caller: ExtensionCaller, details: unknown) => {
    const current = currentPermissions(caller.extension)
    return requested(details).every((name) => current.has(name) || current.has('<all_urls>'))
  },
  getAll: (caller: ExtensionCaller) => permissionsObject(currentPermissions(caller.extension)),
  // Why no prompt: Electron does not gate APIs on optional permissions, so granting only tells the
  // extension what it may already do. Anything the manifest does not declare is refused.
  request: (caller: ExtensionCaller, details: unknown) => {
    const optional = new Set([
      ...declared(caller.extension, 'optional_permissions'),
      ...declared(caller.extension, 'optional_host_permissions')
    ])
    const current = currentPermissions(caller.extension)
    const wanted = requested(details)
    if (!wanted.every((name) => current.has(name) || optional.has(name))) {
      return false
    }
    const added = wanted.filter((name) => !current.has(name))
    if (added.length > 0) {
      const grants = granted.get(caller.extension.id) ?? new Set()
      granted.set(caller.extension.id, grants)
      added.forEach((name) => grants.add(name))
      emitExtensionEvent(
        caller.session,
        'permissions.onAdded',
        [permissionsObject(added)],
        caller.extension.id
      )
    }
    return true
  },
  remove: (caller: ExtensionCaller, details: unknown) => {
    const grants = granted.get(caller.extension.id)
    const removed = requested(details).filter((name) => grants?.delete(name))
    if (removed.length > 0) {
      emitExtensionEvent(
        caller.session,
        'permissions.onRemoved',
        [permissionsObject(removed)],
        caller.extension.id
      )
    }
    return removed.length > 0
  }
})

/** chrome.management's ExtensionInfo. */
function extensionInfo(extension: Electron.Extension): Record<string, unknown> {
  const manifest = extension.manifest
  const icons = objectArg(manifest.icons)
  const optionsPage: unknown = objectArg(manifest.options_ui).page ?? manifest.options_page
  return {
    id: extension.id,
    name: extension.name,
    shortName: typeof manifest.short_name === 'string' ? manifest.short_name : extension.name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: extension.version,
    enabled: true,
    mayDisable: true,
    isApp: false,
    type: 'extension',
    installType: 'normal',
    offlineEnabled: false,
    homepageUrl: typeof manifest.homepage_url === 'string' ? manifest.homepage_url : undefined,
    optionsUrl: typeof optionsPage === 'string' ? new URL(optionsPage, extension.url).href : '',
    permissions: permissionsObject(currentPermissions(extension)).permissions,
    hostPermissions: permissionsObject(currentPermissions(extension)).origins,
    icons: Object.entries(icons)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([size, path]) => ({ size: Number(size), url: new URL(path, extension.url).href }))
  }
}

function requireManagement(caller: ExtensionCaller): void {
  if (!declared(caller.extension, 'permissions').includes('management')) {
    throw new Error('chrome.management needs the "management" permission')
  }
}

handleExtensionApi('management', {
  getAll: (caller: ExtensionCaller) => {
    requireManagement(caller)
    return caller.session.extensions.getAllExtensions().map(extensionInfo)
  },
  get: (caller: ExtensionCaller, id: unknown) => {
    requireManagement(caller)
    const extension = caller.session.extensions.getExtension(stringArg(id, 'id'))
    if (!extension) {
      throw new Error(`Failed to find extension with id ${String(id)}`)
    }
    return extensionInfo(extension)
  }
})

handleExtensionApi('commands', {
  getAll: (caller: ExtensionCaller) =>
    listBrowserExtensionCommands(caller.extension, process.platform)
})
