import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../../shared/secure-storage/secret-store'

const fromPartition = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: vi.fn() } },
  session: { fromPartition }
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root = ''
let realFile = ''
let mockFile = ''

const cookie = {
  name: 'sid',
  value: 'new',
  domain: 'example.com',
  path: '/',
  session: true,
  secure: true,
  httpOnly: true,
  hostOnly: true
}

async function loadInMockKeychainDevMode() {
  vi.resetModules()
  const { configureDevKeychain } =
    await import('../../../startup/chromium-policy/configure-dev-keychain')
  configureDevKeychain(true)
  const snapshots = await import('./browser-session-cookie-snapshot-file')
  snapshots.configureBrowserSessionCookieSnapshots(root)
  return import('./browser-session-cookie-restore')
}

const readOrNull = (path: string) => readFile(path, 'utf8').catch(() => null)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-cookie-keychain-mode-'))
  realFile = join(root, 'browser-session-cookies', 'test-profile.json')
  mockFile = join(root, 'browser-session-cookies-mock-keychain', 'test-profile.json')
  await mkdir(join(root, 'browser-session-cookies'))
  await writeFile(realFile, 'real-keychain snapshot')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    describeProtectionGap: () => null
  })
})

afterEach(async () => {
  _resetSecretStoreForTests()
  Object.defineProperty(process, 'platform', originalPlatform)
  await rm(root, { recursive: true, force: true })
})

it('a mock-keychain dev run saves to its own snapshot and leaves the real-keychain one intact', async () => {
  const restore = await loadInMockKeychainDevMode()
  await mkdir(join(root, 'browser-session-cookies-mock-keychain'))
  await writeFile(mockFile, 'mock-keychain snapshot')
  const cookies = Object.assign(new EventEmitter(), { get: async () => [cookie] })
  fromPartition.mockReturnValue({ cookies })
  restore.trackBrowserSessionCookies({
    id: 'test-profile',
    scope: 'isolated',
    partition: 'persist:test',
    label: 'test',
    source: null
  })

  cookies.emit('changed', {}, cookie, 'explicit', false)
  await restore.flushBrowserSessionCookiesOnQuit()

  // The save lands in the mock folder (here it empties it); the real-keychain bytes survive.
  expect(await readOrNull(mockFile)).not.toBe('mock-keychain snapshot')
  expect(await readOrNull(realFile)).toBe('real-keychain snapshot')
})

it('clearing cookies or deleting the profile drops both keychain modes’ snapshots', async () => {
  const restore = await loadInMockKeychainDevMode()
  await mkdir(join(root, 'browser-session-cookies-mock-keychain'))
  await writeFile(mockFile, 'mock-keychain snapshot')

  await restore.forgetOtherKeychainModeSessionCookies('test-profile')
  expect(await readOrNull(realFile)).toBeNull()
  expect(await readOrNull(mockFile)).toBe('mock-keychain snapshot')

  await writeFile(realFile, 'real-keychain snapshot')
  restore.forgetBrowserSessionCookies('test-profile')
  await expect.poll(() => readOrNull(mockFile)).toBeNull()
  await expect.poll(() => readOrNull(realFile)).toBeNull()
})
