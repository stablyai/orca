import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserExtensionActionResult,
  InstalledBrowserExtension
} from '../../../shared/browser/extensions/browser-extension-types'

const mocks = vi.hoisted(() => {
  const installed: InstalledBrowserExtension[] = []
  return {
    installed,
    reload: vi.fn(async (): Promise<BrowserExtensionActionResult> => ({ ok: true })),
    list: vi.fn(async () => ({ active: true, extensions: [] }))
  }
})
vi.mock('../sessions/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: (id: string) => (id === 'default' || id === 'work' ? { id } : null)
  }
}))
vi.mock('./installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ list: () => mocks.installed })
}))
vi.mock('./browser-extension-management', () => ({
  listBrowserExtensionsForProfile: mocks.list,
  reloadUnpackedBrowserExtension: mocks.reload
}))
import { desktopBrowserExtensions } from './browser-extension-commands'

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
let directory: string

/** Creates an unpacked install record in the temporary source folder, with per-case overrides. */
function extension(overrides: Partial<InstalledBrowserExtension> = {}): InstalledBrowserExtension {
  return {
    id: ID,
    name: 'Dev',
    version: '1',
    path: directory,
    source: 'unpacked',
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null,
    ...overrides
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.reload.mockResolvedValue({ ok: true })
  mocks.installed = []
  directory = await mkdtemp(join(tmpdir(), 'orca-extension-command-'))
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('desktop extension commands', () => {
  it('uses the selected profile for listing and defaults to default', async () => {
    await desktopBrowserExtensions.list({})
    expect(mocks.list).toHaveBeenCalledWith('default')
    await desktopBrowserExtensions.list({ profileId: 'work' })
    expect(mocks.list).toHaveBeenCalledWith('work')
  })

  it('reloads through the UI manager and reports its cross-profile scope', async () => {
    mocks.installed = [extension()]
    await expect(
      desktopBrowserExtensions.reload({ extensionId: ID, profileId: 'work' })
    ).resolves.toEqual({ extensionId: ID, scope: 'enabled-profiles' })
    expect(mocks.reload).toHaveBeenCalledWith(ID)
  })

  it('matches canonical source folders including a directory alias', async () => {
    const source = join(directory, 'source')
    const alias = join(directory, 'alias')
    await mkdir(source)
    await symlink(source, alias, 'junction')
    mocks.installed = [extension({ path: source })]
    await expect(desktopBrowserExtensions.reload({ path: alias })).resolves.toEqual({
      extensionId: ID,
      scope: 'enabled-profiles'
    })
    expect(mocks.reload).toHaveBeenCalledWith(ID)
  })

  it('rejects ambiguous source folders without reloading either extension', async () => {
    mocks.installed = [extension(), extension({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })]
    await expect(desktopBrowserExtensions.reload({ path: directory })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('never installs or reloads a new folder', async () => {
    await expect(desktopBrowserExtensions.reload({ path: directory })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('rejects a file instead of a source folder', async () => {
    const file = join(directory, 'file')
    await writeFile(file, '')
    mocks.installed = [extension({ path: file })]
    await expect(desktopBrowserExtensions.reload({ path: file })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { extensionId: 'invalid' },
    { extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    { extensionId: ID, path: '/conflict' },
    { extensionId: ID, profileId: 'missing' },
    { path: 'relative' },
    { path: '/orca-extension-source-does-not-exist' }
  ])('rejects invalid selection %j before mutation', async (params) => {
    mocks.installed = [extension()]
    await expect(desktopBrowserExtensions.reload(params)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('rejects unknown profiles for listing', async () => {
    await expect(desktopBrowserExtensions.list({ profileId: 'missing' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('refuses webstore reloads by id and by source folder', async () => {
    mocks.installed = [extension({ source: 'webstore' })]
    await expect(desktopBrowserExtensions.reload({ extensionId: ID })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(desktopBrowserExtensions.reload({ path: directory })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('surfaces manager failures without reporting success', async () => {
    mocks.installed = [extension()]
    mocks.reload.mockResolvedValueOnce({ ok: false, error: 'Extensions disabled' })
    await expect(desktopBrowserExtensions.reload({ extensionId: ID })).rejects.toMatchObject({
      code: 'runtime_error',
      message: 'Extensions disabled'
    })
  })
})
