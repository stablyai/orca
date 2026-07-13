import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const enrichMissingRepoGitRemoteIdentitiesMock = vi.hoisted(() => vi.fn())

vi.mock('../repo-git-remote-identity-enrichment', () => ({
  enrichMissingRepoGitRemoteIdentities: enrichMissingRepoGitRemoteIdentitiesMock
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn()
  },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const store = {
  getRepos: vi.fn(() => [])
}

describe('OrcaRuntimeService repo enrichment authority', () => {
  it('does not grant runtime-path authority to the desktop-hosted runtime service', () => {
    const desktopRuntime = new OrcaRuntimeService(store as never)

    desktopRuntime.enrichMissingRepoGitRemoteIdentities()

    expect(enrichMissingRepoGitRemoteIdentitiesMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ probeRuntimeHostPaths: false })
    )
  })

  it('grants runtime-path authority only to the serving runtime process', () => {
    const servingRuntime = new OrcaRuntimeService(store as never, undefined, {
      ownsPersistedRuntimeHostPaths: true
    })

    servingRuntime.enrichMissingRepoGitRemoteIdentities()

    expect(enrichMissingRepoGitRemoteIdentitiesMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ probeRuntimeHostPaths: true })
    )
  })
})
