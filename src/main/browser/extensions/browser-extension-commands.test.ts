import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
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
    reload: vi.fn(async (): Promise<BrowserExtensionActionResult> => ({ ok: true }))
  }
})
vi.mock('../sessions/profiles/browser-session-registry', () => ({ browserSessionRegistry: {} }))
vi.mock('./installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ list: () => mocks.installed })
}))
vi.mock('./browser-extension-management', () => ({
  reloadUnpackedBrowserExtension: mocks.reload
}))
import { desktopBrowserExtensions } from './browser-extension-commands'

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
let directory: string

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
  mocks.installed = []
  directory = await mkdtemp(join(tmpdir(), 'orca-extension-command-'))
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('desktop extension reload', () => {
  it('reloads the installed unpacked extension whose source folder matches through an alias', async () => {
    const source = join(directory, 'source')
    const alias = join(directory, 'alias')
    await mkdir(source)
    await symlink(source, alias, 'junction')
    mocks.installed = [extension({ path: source })]
    await expect(desktopBrowserExtensions.reload({ path: alias })).resolves.toEqual({
      extensionId: ID
    })
    expect(mocks.reload).toHaveBeenCalledWith(ID)
  })

  it('rejects a source folder shared by two installs without reloading either', async () => {
    mocks.installed = [extension(), extension({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })]
    await expect(desktopBrowserExtensions.reload({ path: directory })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('never installs or reloads a folder that is not installed', async () => {
    await expect(desktopBrowserExtensions.reload({ path: directory })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('refuses Web Store extensions', async () => {
    mocks.installed = [extension({ source: 'webstore' })]
    await expect(desktopBrowserExtensions.reload({ extensionId: ID })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('surfaces a manager failure instead of reporting success', async () => {
    mocks.installed = [extension()]
    mocks.reload.mockResolvedValueOnce({ ok: false, error: 'Extensions disabled' })
    await expect(desktopBrowserExtensions.reload({ extensionId: ID })).rejects.toMatchObject({
      code: 'runtime_error',
      message: 'Extensions disabled'
    })
  })
})
