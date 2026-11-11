import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type { GlobalSettings } from '../../shared/global-settings-types'

import {
  getFloatingWorkspaceFileRoots,
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

  it('never re-points an existing trusted folder swapped for a link when trusting another', async () => {
    await mkdir(path.join(tempRoot, 'a'))
    const approved = await realpath(path.join(tempRoot, 'a'))
    const elsewhere = path.join(tempRoot, 'b')
    const other = path.join(tempRoot, 'c')
    await mkdir(elsewhere)
    await mkdir(other)
    const store = createStore({ floatingTerminalCwd: approved })
    await trustFloatingWorkspaceDirectory(store, approved)
    await rm(approved, { recursive: true })
    await symlinkDirectory(elsewhere, approved)

    await trustFloatingWorkspaceDirectory(store, other)

    const canonicalElsewhere = await realpath(elsewhere)
    expect(store.settings.floatingTerminalTrustedCwds).not.toContain(canonicalElsewhere)
    store.settings = { ...store.settings, floatingTerminalCwd: canonicalElsewhere }
    expect((await getFloatingWorkspaceFileRoots(store)).exactRoots).toEqual([])
  })
})
