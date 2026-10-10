import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => {
    throw new Error('no registry in tests')
  },
  WINDOWS_REG_SZ: 1
}))

const { findNativeMessagingHost } = await import('./native-messaging-host-manifest')

describe('findNativeMessagingHost', () => {
  let userData: string
  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'orca-native-hosts-'))
    await mkdir(join(userData, 'NativeMessagingHosts'))
  })
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  const writeManifest = (name: string, manifest: object) =>
    writeFile(join(userData, 'NativeMessagingHosts', `${name}.json`), JSON.stringify(manifest))

  it("reads a host from Orca's own folder", async () => {
    await writeManifest('com.example.host', {
      name: 'com.example.host',
      type: 'stdio',
      path: '/opt/host',
      allowed_origins: ['chrome-extension://abc/']
    })
    expect(await findNativeMessagingHost('com.example.host', userData, 'linux')).toEqual({
      name: 'com.example.host',
      path: '/opt/host',
      allowedOrigins: ['chrome-extension://abc/']
    })
  })

  it('refuses names that could leave the manifest folders', async () => {
    expect(await findNativeMessagingHost('../evil', userData, 'linux')).toBeNull()
  })

  it('skips a manifest whose name does not match', async () => {
    await writeManifest('com.example.host', { name: 'other', type: 'stdio', path: '/opt/host' })
    expect(await findNativeMessagingHost('com.example.host', userData, 'linux')).toBeNull()
  })
})
