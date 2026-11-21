import { describe, expect, it } from 'vitest'
import {
  nativeHostManifestSources,
  type NativeHostLocationEnvironment
} from './browser-extension-native-host-locations'
import {
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
})
