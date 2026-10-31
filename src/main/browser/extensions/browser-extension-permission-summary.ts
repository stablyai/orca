import type { BrowserExtensionAccessLists } from '../../../shared/browser-extension-permission-warnings'

/**
 * What an extension can do, read from its manifest for the install prompt and the download check.
 * hostPermissions: host_permissions, host entries of MV2 `permissions`, and content script matches.
 */
export type BrowserExtensionPermissionSummary = BrowserExtensionAccessLists

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function isHostPattern(permission: string): boolean {
  return permission === '<all_urls>' || permission.includes('://')
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function summarizeManifestPermissions(manifest: unknown): BrowserExtensionPermissionSummary {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { permissions: [], hostPermissions: [] }
  }
  const fields = new Map(Object.entries(manifest))
  const declared = strings(fields.get('permissions'))
  const contentScripts = fields.get('content_scripts')
  const contentScriptMatches = Array.isArray(contentScripts)
    ? contentScripts.flatMap((script: unknown) =>
        script !== null && typeof script === 'object'
          ? strings(new Map(Object.entries(script)).get('matches'))
          : []
      )
    : []
  return {
    permissions: sortedUnique(declared.filter((permission) => !isHostPattern(permission))),
    hostPermissions: sortedUnique([
      ...declared.filter(isHostPattern),
      ...strings(fields.get('host_permissions')),
      ...contentScriptMatches
    ])
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Chrome refuses a store download whose manifest differs from the one the user approved. */
export function samePermissionSummary(
  a: BrowserExtensionPermissionSummary,
  b: BrowserExtensionPermissionSummary
): boolean {
  return sameList(a.permissions, b.permissions) && sameList(a.hostPermissions, b.hostPermissions)
}
