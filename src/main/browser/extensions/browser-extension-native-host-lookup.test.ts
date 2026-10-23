import { describe, expect, it } from 'vitest'
import {
  nativeHostManifestSources,
  type NativeHostLocationEnvironment
} from './browser-extension-native-host-locations'
import {
  parseNativeHostManifest,
  resolveNativeMessagingHost,
  type NativeHostLookupDeps
} from './browser-extension-native-host-lookup'

const EXTENSION = 'nngceckbapebfimnlniiiahkandclblb'
const OTHER = 'a'.repeat(32)
const NAME = 'com.example.vault'

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: NAME,
    description: 'Vault desktop',
    type: 'stdio',
    path: '/opt/vault/host',
    allowed_origins: [`chrome-extension://${EXTENSION}/`],
    ...overrides
  })
}

function lookup(
  env: NativeHostLocationEnvironment,
  files: Record<string, string>,
  registry: Record<string, string> = {}
) {
  const reads: string[] = []
  const deps: NativeHostLookupDeps = {
    platform: env.platform,
    sources: nativeHostManifestSources(env),
    readFile: async (path) => {
      reads.push(path)
      return files[path] ?? null
    },
    isFile: async (path) => path in files,
    readRegistryDefault: (root, key) => registry[`${root}\\${key}`] ?? null
  }
  return {
    reads,
    resolve: (name = NAME, extensionId = EXTENSION) =>
      resolveNativeMessagingHost(name, extensionId, deps)
  }
}

const MAC: NativeHostLocationEnvironment = {
  platform: 'darwin',
  homeDir: '/Users/me',
  userDataDir: '/Users/me/Library/Application Support/orca'
}
const LINUX: NativeHostLocationEnvironment = {
  platform: 'linux',
  homeDir: '/home/me',
  userDataDir: '/home/me/.config/orca'
}
const WINDOWS: NativeHostLocationEnvironment = {
  platform: 'win32',
  homeDir: 'C:\\Users\\me',
  userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\orca'
}

describe('native messaging host manifests', () => {
  it('accepts a Chrome manifest and refuses each field Chrome refuses', () => {
    expect(parseNativeHostManifest(manifest())).toMatchObject({
      name: NAME,
      path: '/opt/vault/host'
    })
    for (const bad of [
      { name: 'Com.Example' },
      { description: '' },
      { description: undefined },
      { type: 'socket' },
      { path: '' },
      { allowed_origins: `chrome-extension://${EXTENSION}/` },
      { allowed_origins: ['chrome-extension://*/'] },
      { allowed_origins: ['<all_urls>'] },
      { allowed_origins: [`chrome-extension://${EXTENSION}`] },
      { allowed_origins: [42] }
    ]) {
      expect(parseNativeHostManifest(manifest(bad))).toBeNull()
    }
    expect(parseNativeHostManifest('[]')).toBeNull()
    expect(parseNativeHostManifest('{')).toBeNull()
  })

  it('uses Chrome error strings for a bad name, a missing host and a forbidden extension', async () => {
    const mac = lookup(MAC, {
      [`/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NAME}.json`]:
        manifest(),
      '/opt/vault/host': ''
    })
    for (const name of ['', 'Com.example', 'com..example', '.com', 'com.', 'com-example']) {
      expect(await mac.resolve(name)).toEqual({
        ok: false,
        error: 'Invalid native messaging host name specified.'
      })
    }
    expect(await mac.resolve('com.example.missing')).toEqual({
      ok: false,
      error: 'Specified native messaging host not found.'
    })
    expect(await mac.resolve(NAME, OTHER)).toEqual({
      ok: false,
      error: 'Access to the specified native messaging host is forbidden.'
    })
    expect(await mac.resolve()).toMatchObject({ ok: true, program: '/opt/vault/host' })
  })

  it('allows only the exact extension origin, with Chrome path patterns', async () => {
    for (const [origin, allowed] of [
      [`chrome-extension://${EXTENSION}/`, true],
      [`chrome-extension://${EXTENSION}/*`, true],
      [`chrome-extension://${EXTENSION}/popup.html`, false],
      [`chrome-extension://${EXTENSION}x/`, false],
      [`https://${EXTENSION}/`, null]
    ] as const) {
      const files = {
        [`${MAC.userDataDir}/NativeMessagingHosts/${NAME}.json`]: manifest({
          allowed_origins: [origin]
        }),
        '/opt/vault/host': ''
      }
      const result = await lookup(MAC, files).resolve()
      expect(result.ok, origin).toBe(allowed === true)
      if (allowed === false) {
        expect(result).toMatchObject({ error: expect.stringContaining('forbidden') })
      }
    }
  })

  it('reads Orca, then Chrome and Chromium user and system folders, then other browsers on macOS', async () => {
    const mac = lookup(MAC, {})
    await mac.resolve()
    expect(mac.reads).toEqual([
      `/Users/me/Library/Application Support/orca/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/Chromium/NativeMessagingHosts/${NAME}.json`,
      `/Library/Google/Chrome/NativeMessagingHosts/${NAME}.json`,
      `/Library/Application Support/Chromium/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/Microsoft Edge/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/Vivaldi/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/Arc/User Data/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/net.imput.helium/NativeMessagingHosts/${NAME}.json`,
      `/Users/me/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts/${NAME}.json`
    ])
  })

  it('reads ~/.config (or XDG_CONFIG_HOME) and the system folders on Linux', async () => {
    const linux = lookup({ ...LINUX, xdgConfigHome: '/home/me/xdg' }, {})
    await linux.resolve()
    expect(linux.reads).toEqual([
      `/home/me/.config/orca/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/google-chrome/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/chromium/NativeMessagingHosts/${NAME}.json`,
      `/etc/opt/chrome/native-messaging-hosts/${NAME}.json`,
      `/etc/chromium/native-messaging-hosts/${NAME}.json`,
      `/home/me/xdg/BraveSoftware/Brave-Browser/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/microsoft-edge/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/vivaldi/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/net.imput.helium/NativeMessagingHosts/${NAME}.json`,
      `/home/me/xdg/opera/NativeMessagingHosts/${NAME}.json`
    ])
  })

  it('stops at the first usable manifest and falls through stale or forbidding ones', async () => {
    const stale = `${LINUX.homeDir}/.config/google-chrome/NativeMessagingHosts/${NAME}.json`
    const forbidding = `${LINUX.homeDir}/.config/chromium/NativeMessagingHosts/${NAME}.json`
    const good = `/etc/opt/chrome/native-messaging-hosts/${NAME}.json`
    const linux = lookup(LINUX, {
      [stale]: manifest({ path: '/gone/host' }),
      [forbidding]: manifest({ allowed_origins: [`chrome-extension://${OTHER}/`] }),
      [good]: manifest(),
      '/opt/vault/host': ''
    })
    expect(await linux.resolve()).toEqual({
      ok: true,
      program: '/opt/vault/host',
      manifestPath: good
    })
    expect(linux.reads.at(-1)).toBe(good)
  })

  it('refuses a relative host path outside Windows', async () => {
    const linux = lookup(LINUX, {
      [`/home/me/.config/orca/NativeMessagingHosts/${NAME}.json`]: manifest({ path: 'host' }),
      '/home/me/.config/orca/NativeMessagingHosts/host': ''
    })
    expect(await linux.resolve()).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found')
    })
  })

  it('reads the registry HKCU before HKLM, 32-bit view first, and resolves a relative path on Windows', async () => {
    const manifestPath = 'C:\\Program Files\\Vault\\vault-host.json'
    const queried: string[] = []
    const registry = {
      [`HKLM\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`]: manifestPath
    }
    const deps: NativeHostLookupDeps = {
      platform: 'win32',
      sources: nativeHostManifestSources(WINDOWS),
      readFile: async (path) =>
        path === manifestPath ? manifest({ path: 'bin\\host.exe' }) : null,
      isFile: async (path) => path === 'C:\\Program Files\\Vault\\bin\\host.exe',
      readRegistryDefault: (root, key) => {
        queried.push(`${root}\\${key}`)
        return registry[`${root}\\${key}`] ?? null
      }
    }
    expect(await resolveNativeMessagingHost(NAME, EXTENSION, deps)).toEqual({
      ok: true,
      program: 'C:\\Program Files\\Vault\\bin\\host.exe',
      manifestPath
    })
    expect(queried).toEqual([
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`,
      `HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`,
      `HKLM\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`
    ])
  })

  it('looks in Orca’s own folder first on Windows and ignores a relative registry value', async () => {
    const own = `${WINDOWS.userDataDir}\\NativeMessagingHosts\\${NAME}.json`
    const reads: string[] = []
    const deps: NativeHostLookupDeps = {
      platform: 'win32',
      sources: nativeHostManifestSources(WINDOWS),
      readFile: async (path) => {
        reads.push(path)
        return null
      },
      isFile: async () => false,
      readRegistryDefault: () => 'relative\\vault.json'
    }
    expect(await resolveNativeMessagingHost(NAME, EXTENSION, deps)).toMatchObject({ ok: false })
    expect(reads).toEqual([own])
  })
})
