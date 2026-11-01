import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'
import type { BrowserExtensionProfileState } from './browser-extension-profile-state-store'

/** chrome.permissions.Permissions */
export type BrowserExtensionPermissionSet = { permissions: string[]; origins: string[] }

type ManifestLike = Record<string, unknown> | undefined

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function isOriginPattern(value: string): boolean {
  return value === '<all_urls>' || value.includes('://')
}

function split(entries: string[]): BrowserExtensionPermissionSet {
  return {
    permissions: entries.filter((entry) => !isOriginPattern(entry)),
    origins: entries.filter(isOriginPattern)
  }
}

/** MV2 lists hosts among (optional_)permissions; MV3 moved them to (optional_)host_permissions. */
export function manifestPermissionSets(manifest: ManifestLike): {
  required: BrowserExtensionPermissionSet
  optional: BrowserExtensionPermissionSet
} {
  const required = split(stringList(manifest?.permissions))
  const optional = split(stringList(manifest?.optional_permissions))
  required.origins.push(...stringList(manifest?.host_permissions))
  optional.origins.push(...stringList(manifest?.optional_host_permissions))
  return { required, optional }
}

const PATTERN = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/

/** Whether every URL `requested` matches is also matched by `granted` (Chrome's subset rule). */
export function originPatternCovers(granted: string, requested: string): boolean {
  if (granted === '<all_urls>') {
    return true
  }
  if (requested === '<all_urls>') {
    return false
  }
  const g = PATTERN.exec(granted)
  const r = PATTERN.exec(requested)
  if (!g || !r) {
    return false
  }
  const [, gScheme, gHost = '', gPath] = g
  const [, rScheme, rHost = '', rPath] = r
  const schemeOk =
    gScheme === rScheme || (gScheme === '*' && ['http', 'https', 'ws', 'wss'].includes(rScheme))
  const gh = gHost.toLowerCase()
  const rh = rHost.toLowerCase()
  const hostOk =
    gh === '*' ||
    gh === rh ||
    (gh.startsWith('*.') && (rh === gh.slice(2) || rh.endsWith(gh.slice(1))))
  const pathOk =
    gPath === rPath ||
    gPath === '/*' ||
    (!rPath.includes('*') && matchesExtensionMatchPattern(`https://x${gPath}`, `https://x${rPath}`))
  return schemeOk && hostOk && pathOk
}

function covered(origin: string, patterns: string[]): boolean {
  return patterns.some((pattern) => originPatternCovers(pattern, origin))
}

export function effectiveBrowserExtensionPermissions(
  manifest: ManifestLike,
  state: Pick<BrowserExtensionProfileState, 'grantedPermissions' | 'grantedOrigins'>
): BrowserExtensionPermissionSet {
  const { required } = manifestPermissionSets(manifest)
  return {
    permissions: [...new Set([...required.permissions, ...state.grantedPermissions])],
    origins: [...new Set([...required.origins, ...state.grantedOrigins])]
  }
}

export function containsBrowserExtensionPermissions(
  manifest: ManifestLike,
  state: Pick<BrowserExtensionProfileState, 'grantedPermissions' | 'grantedOrigins'>,
  request: Partial<BrowserExtensionPermissionSet>
): boolean {
  const effective = effectiveBrowserExtensionPermissions(manifest, state)
  return (
    (request.permissions ?? []).every((permission) => effective.permissions.includes(permission)) &&
    (request.origins ?? []).every((origin) => covered(origin, effective.origins))
  )
}

/** Host patterns an extension may use in Orca-owned checks: the manifest's plus granted ones. */
export function browserExtensionHostPatterns(
  manifest: ManifestLike,
  state: Pick<BrowserExtensionProfileState, 'grantedPermissions' | 'grantedOrigins'>
): string[] {
  return effectiveBrowserExtensionPermissions(manifest, state).origins
}

export function hasBrowserExtensionHostPermission(patterns: string[], url: string): boolean {
  return patterns.some((pattern) => matchesExtensionMatchPattern(pattern, url))
}

const NOT_IN_MANIFEST = 'Only permissions specified in the manifest may be requested.'

export type BrowserExtensionPermissionRequestPlan =
  | { kind: 'invalid'; error: string }
  | { kind: 'already-granted' }
  | { kind: 'prompt'; add: BrowserExtensionPermissionSet }

/** permissions.request: what to ask the user for, or why the request is refused outright. */
export function planBrowserExtensionPermissionRequest(
  manifest: ManifestLike,
  state: Pick<BrowserExtensionProfileState, 'grantedPermissions' | 'grantedOrigins'>,
  request: Partial<BrowserExtensionPermissionSet>
): BrowserExtensionPermissionRequestPlan {
  const { required, optional } = manifestPermissionSets(manifest)
  const effective = effectiveBrowserExtensionPermissions(manifest, state)
  const permissions = [...new Set(request.permissions ?? [])]
  const origins = [...new Set(request.origins ?? [])]
  for (const permission of permissions) {
    if (!required.permissions.includes(permission) && !optional.permissions.includes(permission)) {
      return { kind: 'invalid', error: NOT_IN_MANIFEST }
    }
  }
  for (const origin of origins) {
    if (!covered(origin, [...required.origins, ...optional.origins])) {
      return { kind: 'invalid', error: NOT_IN_MANIFEST }
    }
  }
  const add = {
    permissions: permissions.filter((permission) => !effective.permissions.includes(permission)),
    origins: origins.filter((origin) => !covered(origin, effective.origins))
  }
  return add.permissions.length === 0 && add.origins.length === 0
    ? { kind: 'already-granted' }
    : { kind: 'prompt', add }
}

export type BrowserExtensionPermissionRemovalPlan =
  | { kind: 'invalid'; error: string }
  | { kind: 'remove'; removed: BrowserExtensionPermissionSet }

export function planBrowserExtensionPermissionRemoval(
  manifest: ManifestLike,
  state: Pick<BrowserExtensionProfileState, 'grantedPermissions' | 'grantedOrigins'>,
  request: Partial<BrowserExtensionPermissionSet>
): BrowserExtensionPermissionRemovalPlan {
  const { required } = manifestPermissionSets(manifest)
  const permissions = request.permissions ?? []
  const origins = request.origins ?? []
  if (
    permissions.some((permission) => required.permissions.includes(permission)) ||
    origins.some((origin) => required.origins.includes(origin))
  ) {
    return { kind: 'invalid', error: 'You cannot remove required permissions.' }
  }
  return {
    kind: 'remove',
    removed: {
      permissions: permissions.filter((permission) =>
        state.grantedPermissions.includes(permission)
      ),
      origins: origins.filter((origin) => state.grantedOrigins.includes(origin))
    }
  }
}

export function withGrantedPermissions(
  state: BrowserExtensionProfileState,
  add: BrowserExtensionPermissionSet
): BrowserExtensionProfileState {
  return {
    ...state,
    grantedPermissions: [...new Set([...state.grantedPermissions, ...add.permissions])],
    grantedOrigins: [...new Set([...state.grantedOrigins, ...add.origins])]
  }
}

export function withoutGrantedPermissions(
  state: BrowserExtensionProfileState,
  removed: BrowserExtensionPermissionSet
): BrowserExtensionProfileState {
  return {
    ...state,
    grantedPermissions: state.grantedPermissions.filter(
      (permission) => !removed.permissions.includes(permission)
    ),
    grantedOrigins: state.grantedOrigins.filter((origin) => !removed.origins.includes(origin))
  }
}
