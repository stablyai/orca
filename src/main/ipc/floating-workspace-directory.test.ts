import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { GlobalSettings } from '../../shared/global-settings-types'

import {
  ensureDefaultFloatingWorkspacePath,
  trustFloatingWorkspaceDirectory,
  resolveFloatingTerminalCwd,
  sanitizeFloatingWorkspaceDirectorySetting
} from './floating-workspace-directory'

type TestStore = {
  settings: GlobalSettings
  getSettings: () => GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => GlobalSettings
}

function createStore(settings: Partial<GlobalSettings> = {}): TestStore {
  const store: TestStore = {
    settings: {
      floatingTerminalCwd: '',
      floatingTerminalTrustedCwds: [],
      ...settings
    } as GlobalSettings,
    getSettings: () => store.settings,
    updateSettings: (updates) => {
      store.settings = { ...store.settings, ...updates }
      return store.settings
    }
  }
  return store
}

describe('floating workspace directory', () => {
  let tempRoot: string
  let homeDir: string
  let userDataDir: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-floating-workspace-'))
    homeDir = path.join(tempRoot, 'home')
    userDataDir = path.join(tempRoot, 'user-data')
    await mkdir(homeDir)
    installFakeAppEnvironment({
      getPath: (name) => {
        if (name === 'home') {
          return homeDir
        }
        if (name === 'userData') {
          return userDataDir
        }
        throw new Error(`unexpected app path: ${name}`)
      }
    })
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function symlinkDirectory(target: string, linkPath: string): Promise<void> {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }

  it('defaults terminal cwd to home', async () => {
    const store = createStore()

    await expect(resolveFloatingTerminalCwd(store as never)).resolves.toBe(homeDir)
  })

  it('keeps the app-owned directory for floating markdown notes', async () => {
    await expect(ensureDefaultFloatingWorkspacePath()).resolves.toBe(
      path.join(userDataDir, 'floating-workspace')
    )
  })

  it('persists picker-approved directories and resolves them as the cwd', async () => {
    const store = createStore()
    const selectedDir = path.join(tempRoot, 'notes')
    await mkdir(selectedDir)
    const canonicalSelectedDir = await realpath(selectedDir)

    await trustFloatingWorkspaceDirectory(store, selectedDir)

    expect(store.settings.floatingTerminalTrustedCwds).toEqual([canonicalSelectedDir])

    await expect(
      resolveFloatingTerminalCwd(store as never, {
        path: selectedDir,
        requireTrusted: true
      })
    ).resolves.toBe(canonicalSelectedDir)
  })

  it('stores a symlinked choice as its canonical target and rejects the link after retargeting', async () => {
    const store = createStore()
    const originalTarget = path.join(tempRoot, 'original-target')
    const retargetedTarget = path.join(tempRoot, 'retargeted-target')
    const selectedLink = path.join(tempRoot, 'selected-link')
    await mkdir(originalTarget)
    await mkdir(retargetedTarget)
    await symlinkDirectory(originalTarget, selectedLink)
    const canonicalOriginalTarget = await realpath(originalTarget)

    await trustFloatingWorkspaceDirectory(store, selectedLink)

    expect(store.settings.floatingTerminalTrustedCwds).toEqual([canonicalOriginalTarget])

    await unlink(selectedLink)
    await symlinkDirectory(retargetedTarget, selectedLink)
    await expect(
      resolveFloatingTerminalCwd(store as never, {
        path: selectedLink,
        requireTrusted: true
      })
    ).resolves.toBe(path.join(userDataDir, 'floating-workspace'))
    await expect(
      sanitizeFloatingWorkspaceDirectorySetting(store as never, selectedLink)
    ).resolves.toBe('')
  })

  it('keeps temporarily inaccessible trusted directories when adding a new one', async () => {
    const missingTrustedDir = path.join(tempRoot, 'offline-drive', 'notes')
    const selectedDir = path.join(tempRoot, 'new-notes')
    await mkdir(selectedDir)
    const canonicalSelectedDir = await realpath(selectedDir)
    const store = createStore({
      floatingTerminalTrustedCwds: [missingTrustedDir]
    })

    await trustFloatingWorkspaceDirectory(store, selectedDir)

    expect(store.settings.floatingTerminalTrustedCwds).toEqual([
      missingTrustedDir,
      canonicalSelectedDir
    ])
  })

  it('falls back to the app-owned workspace for untrusted settings paths', async () => {
    const store = createStore()
    const arbitraryDir = path.join(tempRoot, 'arbitrary')
    await mkdir(arbitraryDir)

    await expect(
      resolveFloatingTerminalCwd(store as never, {
        path: arbitraryDir,
        requireTrusted: true
      })
    ).resolves.toBe(path.join(userDataDir, 'floating-workspace'))
    await expect(
      sanitizeFloatingWorkspaceDirectorySetting(store as never, arbitraryDir)
    ).resolves.toBe('')
  })

  it('preserves home shorthand as a terminal-only setting', async () => {
    const store = createStore()

    await expect(sanitizeFloatingWorkspaceDirectorySetting(store as never, '~')).resolves.toBe('~')
    await expect(resolveFloatingTerminalCwd(store as never, { path: '~' })).resolves.toBe(homeDir)
    await expect(
      resolveFloatingTerminalCwd(store as never, { path: '~', requireTrusted: true })
    ).resolves.toBe(path.join(userDataDir, 'floating-workspace'))
  })

  it('still resolves accessible ad hoc terminal directories when trust is not required', async () => {
    const store = createStore()
    const arbitraryDir = path.join(tempRoot, 'terminal-only')
    await mkdir(arbitraryDir)

    await expect(resolveFloatingTerminalCwd(store as never, { path: arbitraryDir })).resolves.toBe(
      arbitraryDir
    )
  })
})
