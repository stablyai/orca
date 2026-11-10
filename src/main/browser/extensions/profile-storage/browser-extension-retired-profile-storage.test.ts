import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', storagePath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: vi.fn() },
  session: {
    fromPartition: () => ({
      getStoragePath: () => mocks.storagePath,
      clearStorageData: vi.fn(async () => {}),
      extensions: { getAllExtensions: () => [], getExtension: () => null }
    })
  }
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-retired-'))
mocks.storagePath = join(mocks.userData, 'Partitions', 'orca-browser-session-retired')
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))

it('removes a deleted profile’s open native settings on restart without attaching that profile', async () => {
  const { session } = await import('electron')
  const removal = await import('./browser-extension-data-removal')
  const retiring = await import('./browser-extension-retired-profile-storage')
  const id = 'a'.repeat(32)
  const folder = join(mocks.storagePath, 'Local Extension Settings', id)
  mkdirSync(folder, { recursive: true })
  const sess = session.fromPartition('persist:orca-browser-session-retired')
  removal.noteBrowserExtensionStorageOpened(sess, id)
  await retiring.retireBrowserExtensionProfileStorage(sess, 'persist:orca-browser-session-retired')
  expect(existsSync(folder)).toBe(true)
  await retiring.removeRetiredBrowserExtensionProfileStorage()
  expect(existsSync(folder)).toBe(true)

  vi.resetModules()
  const restarted = await import('./browser-extension-retired-profile-storage')
  await restarted.removeRetiredBrowserExtensionProfileStorage()
  expect(existsSync(folder)).toBe(false)
  expect(
    existsSync(join(mocks.userData, 'browser-extensions', 'retired-profile-storage.json'))
  ).toBe(false)
})
