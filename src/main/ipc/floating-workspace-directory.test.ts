import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'

const { appGetPathMock, authorizeExternalPathMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  authorizeExternalPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  }
}))

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
}))

import {
  grantFloatingWorkspaceDirectory,
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

describe('floating workspace directory authorization', () => {
  let tempRoot: string
  let homeDir: string
  let userDataDir: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-floating-workspace-'))
    homeDir = path.join(tempRoot, 'home')
    userDataDir = path.join(tempRoot, 'user-data')
    await mkdir(homeDir)
    appGetPathMock.mockImplementation((name: string) => {
      if (name === 'home') {
        return homeDir
      }
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected app path: ${name}`)
    })
    authorizeExternalPathMock.mockClear()
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function symlinkDirectory(target: string, linkPath: string): Promise<void> {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }

  it('persists picker-approved directories and reauthorizes them on resolution', async () => {
    const store = createStore()
    const selectedDir = path.join(tempRoot, 'notes')
    await mkdir(selectedDir)
    const canonicalSelectedDir = await realpath(selectedDir)

    await grantFloatingWorkspaceDirectory(store as never, selectedDir)

    expect(store.settings.floatingTerminalTrustedCwds).toEqual([canonicalSelectedDir])
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(canonicalSelectedDir)

    authorizeExternalPathMock.mockClear()
    await expect(
      resolveFloatingTerminalCwd(store as never, {
        path: selectedDir,
        requireTrusted: true
      })
    ).resolves.toBe(canonicalSelectedDir)
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(canonicalSelectedDir)
  })

  it('stores symlink grants as canonical targets and rejects the link after retargeting', async () => {
    const store = createStore()
    const originalTarget = path.join(tempRoot, 'original-target')
    const retargetedTarget = path.join(tempRoot, 'retargeted-target')
    const selectedLink = path.join(tempRoot, 'selected-link')
    await mkdir(originalTarget)
    await mkdir(retargetedTarget)
    await symlinkDirectory(originalTarget, selectedLink)
    const canonicalOriginalTarget = await realpath(originalTarget)

    await grantFloatingWorkspaceDirectory(store as never, selectedLink)

    expect(store.settings.floatingTerminalTrustedCwds).toEqual([canonicalOriginalTarget])
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(canonicalOriginalTarget)

    await unlink(selectedLink)
    await symlinkDirectory(retargetedTarget, selectedLink)
    const canonicalRetargetedTarget = await realpath(retargetedTarget)

    authorizeExternalPathMock.mockClear()
    await expect(
      resolveFloatingTerminalCwd(store as never, {
        path: selectedLink,
        requireTrusted: true
      })
    ).resolves.toBe(path.join(userDataDir, 'floating-workspace'))
    await expect(
      sanitizeFloatingWorkspaceDirectorySetting(store as never, selectedLink)
    ).resolves.toBe('')
    expect(authorizeExternalPathMock).not.toHaveBeenCalledWith(canonicalRetargetedTarget)
  })

  it('keeps temporarily inaccessible trusted directories when adding a new grant', async () => {
    const missingTrustedDir = path.join(tempRoot, 'offline-drive', 'notes')
    const selectedDir = path.join(tempRoot, 'new-notes')
    await mkdir(selectedDir)
    const canonicalSelectedDir = await realpath(selectedDir)
    const store = createStore({
      floatingTerminalTrustedCwds: [missingTrustedDir]
    })

    await grantFloatingWorkspaceDirectory(store as never, selectedDir)

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

  it('still resolves accessible ad hoc terminal directories when trust is not required', async () => {
    const store = createStore()
    const arbitraryDir = path.join(tempRoot, 'terminal-only')
    await mkdir(arbitraryDir)

    await expect(resolveFloatingTerminalCwd(store as never, { path: arbitraryDir })).resolves.toBe(
      arbitraryDir
    )
    expect(authorizeExternalPathMock).not.toHaveBeenCalledWith(arbitraryDir)
  })
})
