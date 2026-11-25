import { posix, win32 } from 'node:path'

/**
 * Where native messaging host manifests (`<name>.json`) are looked up, in order. Orca's own folder
 * comes first so a user can register or override a host for Orca alone. Then Chrome's and
 * Chromium's own locations, user before system as Chrome reads them, then the user folders of other
 * Chromium browsers, where desktop apps often register only for the browsers they detect.
 */

export type NativeHostManifestSource =
  | { kind: 'folder'; folder: string }
  /** Windows: the key's default value is the manifest path; `<name>` is appended as a subkey. */
  | { kind: 'registry'; root: 'HKCU' | 'HKLM'; key: string }

export type NativeHostLocationEnvironment = {
  platform: NodeJS.Platform
  homeDir: string
  /** Orca's userData folder. */
  userDataDir: string
  /** Linux: $XDG_CONFIG_HOME, which Chromium browsers use instead of ~/.config when set. */
  xdgConfigHome?: string
}

export const ORCA_NATIVE_MESSAGING_HOSTS_FOLDER = 'NativeMessagingHosts'

// User data folders under ~/Library/Application Support; Chrome and Chromium also have system ones.
const MAC_OTHER_BROWSERS = [
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
  'Vivaldi',
  'Arc/User Data',
  'net.imput.helium',
  'com.operasoftware.Opera'
]
// User data folders under ~/.config.
const LINUX_OTHER_BROWSERS = [
  'BraveSoftware/Brave-Browser',
  'microsoft-edge',
  'vivaldi',
  'net.imput.helium',
  'opera'
]
// Software\<vendor>\NativeMessagingHosts after Chrome's and Chromium's.
const WINDOWS_OTHER_BROWSERS = ['Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']

function windowsRegistrySources(): NativeHostManifestSource[] {
  const sources: NativeHostManifestSource[] = []
  for (const vendor of ['Google\\Chrome', 'Chromium', ...WINDOWS_OTHER_BROWSERS]) {
    // Why HKCU once: HKCU\Software is shared between the 32- and 64-bit views.
    sources.push({
      kind: 'registry',
      root: 'HKCU',
      key: `Software\\${vendor}\\NativeMessagingHosts`
    })
    // Chrome reads the 32-bit view first; a 64-bit process sees it under WOW6432Node.
    sources.push(
      {
        kind: 'registry',
        root: 'HKLM',
        key: `SOFTWARE\\WOW6432Node\\${vendor}\\NativeMessagingHosts`
      },
      { kind: 'registry', root: 'HKLM', key: `SOFTWARE\\${vendor}\\NativeMessagingHosts` }
    )
  }
  return sources
}

export function nativeHostManifestSources(
  env: NativeHostLocationEnvironment
): NativeHostManifestSource[] {
  const path = env.platform === 'win32' ? win32 : posix
  const own: NativeHostManifestSource = {
    kind: 'folder',
    folder: path.join(env.userDataDir, ORCA_NATIVE_MESSAGING_HOSTS_FOLDER)
  }
  const folders = (list: string[]): NativeHostManifestSource[] =>
    list.map((folder) => ({ kind: 'folder', folder }))
  if (env.platform === 'darwin') {
    const support = posix.join(env.homeDir, 'Library/Application Support')
    const hosts = (base: string): string => posix.join(base, 'NativeMessagingHosts')
    return [
      own,
      ...folders([
        hosts(posix.join(support, 'Google/Chrome')),
        hosts(posix.join(support, 'Chromium')),
        '/Library/Google/Chrome/NativeMessagingHosts',
        '/Library/Application Support/Chromium/NativeMessagingHosts',
        ...MAC_OTHER_BROWSERS.map((browser) => hosts(posix.join(support, browser)))
      ])
    ]
  }
  if (env.platform === 'win32') {
    return [own, ...windowsRegistrySources()]
  }
  const config =
    env.xdgConfigHome && posix.isAbsolute(env.xdgConfigHome)
      ? env.xdgConfigHome
      : posix.join(env.homeDir, '.config')
  const hosts = (browser: string): string => posix.join(config, browser, 'NativeMessagingHosts')
  return [
    own,
    ...folders([
      hosts('google-chrome'),
      hosts('chromium'),
      '/etc/opt/chrome/native-messaging-hosts',
      '/etc/chromium/native-messaging-hosts',
      ...LINUX_OTHER_BROWSERS.map(hosts)
    ])
  ]
}
