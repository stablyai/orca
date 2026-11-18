import { EventEmitter } from 'node:events'
import {
  setSecretStore,
  _resetSecretStoreForTests
} from '../../../../shared/secure-storage/secret-store'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const fromPartition = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => true } },
  session: { fromPartition }
}))

it('mock saves preserve real snapshots and explicit deletion removes both modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cookie-keychain-mode-'))
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const {
      configureBrowserSessionCookieSnapshots,
      clearBrowserSessionCookieSnapshots,
      forgetBrowserSessionCookies,
      trackBrowserSessionCookies,
      flushBrowserSessionCookiesOnQuit
    } = await import('./browser-session-cookie-restore')
    configureBrowserSessionCookieSnapshots(root)
    const realFile = join(root, 'browser-session-cookies', 'test-profile.json')
    const mockFile = join(root, 'browser-session-cookies-mock-keychain', 'test-profile.json')
    await mkdir(join(root, 'browser-session-cookies'))
    await mkdir(join(root, 'browser-session-cookies-mock-keychain'))
    await writeFile(realFile, 'existing encrypted browser sign-ins')
    await writeFile(mockFile, 'test browser sign-ins')
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
      describeProtectionGap: () => null
    })
    const cookie = {
      name: 'test',
      value: 'new',
      domain: 'example.com',
      path: '/',
      session: true,
      secure: true,
      httpOnly: true,
      hostOnly: true
    }
    const cookies = Object.assign(new EventEmitter(), { get: async () => [cookie] })
    fromPartition.mockReturnValue({ cookies })
    trackBrowserSessionCookies({
      id: 'test-profile',
      scope: 'isolated',
      partition: 'persist:test',
      label: 'test',
      source: null
    })
    cookies.emit('changed', {}, cookie, 'explicit', false)
    await flushBrowserSessionCookiesOnQuit()
    await expect.poll(async () => readFile(mockFile, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(realFile, 'utf8')).toBe('existing encrypted browser sign-ins')
    await writeFile(mockFile, 'test browser sign-ins')
    await clearBrowserSessionCookieSnapshots('test-profile')
    expect(await readFile(mockFile, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(realFile, 'utf8').catch(() => null)).toBeNull()
    await writeFile(realFile, 'real cookies')
    await writeFile(mockFile, 'mock cookies')
    forgetBrowserSessionCookies('test-profile')
    await expect.poll(async () => readFile(mockFile, 'utf8').catch(() => null)).toBeNull()
    await expect.poll(async () => readFile(realFile, 'utf8').catch(() => null)).toBeNull()
  } finally {
    _resetSecretStoreForTests()
    Object.defineProperty(process, 'platform', originalPlatform)
    await rm(root, { recursive: true, force: true })
  }
})
