import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../../windows-native-registry'

/** A native messaging host as its manifest declares it. */
export type NativeMessagingHost = { name: string; path: string; allowedOrigins: string[] }

// Chrome's rule for host names; it also keeps a name from walking out of the manifest folders.
const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i

/**
 * Where hosts register, in Chrome's search order. Orca's own folder comes first; after it, the
 * folders of Chrome and Chromium, so hosts that installed for Chrome (1Password, Bitwarden) work.
 */
function manifestFolders(userDataPath: string, platform: NodeJS.Platform): string[] {
  const home = homedir()
  const own = join(userDataPath, 'NativeMessagingHosts')
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      own,
      join(support, 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(support, 'Chromium', 'NativeMessagingHosts'),
      '/Library/Google/Chrome/NativeMessagingHosts',
      '/Library/Application Support/Chromium/NativeMessagingHosts'
    ]
  }
  if (platform === 'linux') {
    return [
      own,
      join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      '/etc/opt/chrome/native-messaging-hosts',
      '/etc/chromium/native-messaging-hosts'
    ]
  }
  return [own]
}

/** Windows registers each host's manifest path under a registry key instead of a folder. */
function windowsManifestPaths(name: string): string[] {
  let registry: ReturnType<typeof loadWindowsNativeRegistry>
  try {
    registry = loadWindowsNativeRegistry()
  } catch {
    return []
  }
  const paths: string[] = []
  for (const root of [registry.HK.CU, registry.HK.LM]) {
    for (const browser of ['Google\\Chrome', 'Chromium']) {
      try {
        const values = registry.getRegistryKey(
          root,
          `Software\\${browser}\\NativeMessagingHosts\\${name}`
        )
        const entry = values?.[''] ?? values?.['(Default)']
        if (entry?.type === WINDOWS_REG_SZ && typeof entry.value === 'string') {
          paths.push(entry.value)
        }
      } catch {
        // No such key.
      }
    }
  }
  return paths
}

async function readManifest(file: string, name: string): Promise<NativeMessagingHost | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  const manifest = Object(parsed)
  const path: unknown = manifest.path
  const origins: unknown = manifest.allowed_origins
  if (manifest.name !== name || manifest.type !== 'stdio' || typeof path !== 'string') {
    return null
  }
  return {
    name,
    // A relative path is relative to the manifest (Windows only, per Chrome).
    path: isAbsolute(path) ? path : join(dirname(file), path),
    allowedOrigins: Array.isArray(origins)
      ? origins.filter((origin): origin is string => typeof origin === 'string')
      : []
  }
}

/** The first valid manifest for host `name`, or null when none is installed. */
export async function findNativeMessagingHost(
  name: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<NativeMessagingHost | null> {
  if (!HOST_NAME.test(name)) {
    return null
  }
  const files = [
    ...manifestFolders(userDataPath, platform).map((folder) => join(folder, `${name}.json`)),
    ...(platform === 'win32' ? windowsManifestPaths(name) : [])
  ]
  for (const file of files) {
    const host = await readManifest(file, name)
    if (host) {
      return host
    }
  }
  return null
}
