import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../../shared/windows-environment-expansion'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ
} from '../../windows-native-registry'
import { NATIVE_HOST_ERRORS } from './browser-extension-native-host-errors'
import {
  nativeHostManifestSources,
  type NativeHostManifestSource
} from './browser-extension-native-host-locations'

/** Chrome's rule (NativeMessagingHostManifest::IsValidName). */
const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/
const MAX_MANIFEST_BYTES = 1024 * 1024

export function isValidNativeHostName(name: string): boolean {
  return HOST_NAME.test(name)
}

export type NativeHostManifest = {
  name: string
  path: string
  allowedOrigins: { host: string; path: RegExp }[]
}

function originPattern(entry: unknown): { host: string; path: RegExp } | null {
  if (typeof entry !== 'string') {
    return null
  }
  const match = /^chrome-extension:\/\/([^/]*)(\/.*)$/.exec(entry)
  const host = match?.[1].toLowerCase() ?? ''
  // Why refuse wildcards: Chrome requires a fixed list of extensions, never a pattern over them.
  if (!match || host === '' || host.includes('*')) {
    return null
  }
  const glob = match[2]
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.+()[\]{}|]/g, '\\$&')
    )
    .join('')
  return { host, path: new RegExp(`^${glob}$`) }
}

/** Chrome's manifest checks; any bad field makes the whole file unusable. */
export function parseNativeHostManifest(text: string): NativeHostManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const fields: Record<string, unknown> = { ...parsed }
  const { name, description, type, path, allowed_origins: origins } = fields
  if (
    typeof name !== 'string' ||
    !isValidNativeHostName(name) ||
    typeof description !== 'string' ||
    description === '' ||
    type !== 'stdio' ||
    typeof path !== 'string' ||
    path === '' ||
    !Array.isArray(origins)
  ) {
    return null
  }
  const allowedOrigins = origins.map(originPattern)
  if (allowedOrigins.some((pattern) => pattern === null)) {
    return null
  }
  return {
    name,
    path,
    allowedOrigins: allowedOrigins.filter((pattern) => pattern !== null)
  }
}

export function nativeHostManifestAllows(
  manifest: NativeHostManifest,
  extensionId: string
): boolean {
  return manifest.allowedOrigins.some(
    (pattern) => pattern.host === extensionId && pattern.path.test('/')
  )
}

export type NativeHostLookupDeps = {
  platform: NodeJS.Platform
  sources: NativeHostManifestSource[]
  /** Null when missing or unreadable. */
  readFile: (path: string) => Promise<string | null>
  isFile: (path: string) => Promise<boolean>
  /** The key's default value; null when absent. */
  readRegistryDefault: (root: 'HKCU' | 'HKLM', key: string) => string | null
}

export type NativeHostResolution =
  | { ok: true; program: string; manifestPath: string }
  | { ok: false; error: string }

/**
 * Finds the host the extension may start. Unlike Chrome, which reads a single location per level,
 * a broken, stale or forbidding manifest in one browser's folder falls through to the next: apps
 * write one per browser they know and Orca reads several. Forbidden wins over not found.
 */
export async function resolveNativeMessagingHost(
  name: string,
  extensionId: string,
  deps: NativeHostLookupDeps
): Promise<NativeHostResolution> {
  if (!isValidNativeHostName(name)) {
    return { ok: false, error: NATIVE_HOST_ERRORS.invalidName }
  }
  const path = deps.platform === 'win32' ? win32 : posix
  let forbidden = false
  for (const source of deps.sources) {
    const manifestPath =
      source.kind === 'folder'
        ? path.join(source.folder, `${name}.json`)
        : deps.readRegistryDefault(source.root, `${source.key}\\${name}`)
    if (!manifestPath || !path.isAbsolute(manifestPath)) {
      continue
    }
    const text = await deps.readFile(manifestPath)
    const manifest = text === null ? null : parseNativeHostManifest(text)
    if (!manifest || manifest.name !== name) {
      if (text !== null) {
        console.warn(`[browser-extensions] Ignoring invalid native host manifest ${manifestPath}`)
      }
      continue
    }
    if (!nativeHostManifestAllows(manifest, extensionId)) {
      forbidden = true
      continue
    }
    // Chrome allows a path relative to the manifest's folder on Windows only.
    const program = path.isAbsolute(manifest.path)
      ? manifest.path
      : deps.platform === 'win32'
        ? win32.join(win32.dirname(manifestPath), manifest.path)
        : null
    if (program && (await deps.isFile(program))) {
      return { ok: true, program, manifestPath }
    }
  }
  return {
    ok: false,
    error: forbidden ? NATIVE_HOST_ERRORS.forbidden : NATIVE_HOST_ERRORS.notFound
  }
}

function readRegistryDefault(root: 'HKCU' | 'HKLM', key: string): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    // The default value enumerates with an empty name.
    const value = registry.getRegistryKey(registry.HK[root === 'HKCU' ? 'CU' : 'LM'], key)?.['']
    if (typeof value?.value !== 'string') {
      return null
    }
    return value.type === WINDOWS_REG_EXPAND_SZ
      ? expandWindowsEnvironmentVariables(value.value, process.env)
      : value.type === WINDOWS_REG_SZ
        ? value.value
        : null
  } catch {
    // The registry addon ships with the desktop app only.
    return null
  }
}

export function defaultNativeHostLookupDeps(userDataDir: string): NativeHostLookupDeps {
  return {
    platform: process.platform,
    sources: nativeHostManifestSources({
      platform: process.platform,
      homeDir: homedir(),
      userDataDir,
      xdgConfigHome: process.env.XDG_CONFIG_HOME
    }),
    readFile: async (path) => {
      try {
        if ((await stat(path)).size > MAX_MANIFEST_BYTES) {
          return null
        }
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    },
    readRegistryDefault
  }
}

export function nativeHostOriginArgument(extensionId: string): string {
  return `${getChromeExtensionOrigin(extensionId)}/`
}
