import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

import { OrcaRuntimeService } from './orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const originalPlatform = process.platform

function makeRuntime(repos: Repo[]) {
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getProjects: () => [],
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection resolution reads only the repo, project and settings members supplied here.
  const runtime = new OrcaRuntimeService(store as never)
  const selector = vi.fn<(selector: string) => Promise<ResolvedWorktree>>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replaces the protected worktree lookup this method awaits; its signature is restated above.
  ;(runtime as unknown as { resolveWorktreeSelector: typeof selector }).resolveWorktreeSelector =
    selector
  return { runtime, selector }
}

function worktree(fields: Partial<ResolvedWorktree>): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only repoId, path and hostId.
  return fields as ResolvedWorktree
}

describe('OrcaRuntimeService.resolveAgentDetectionHost', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  const local: Repo = {
    id: 'r1',
    path: 'C:\\src\\r1',
    displayName: 'r1',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: 'local'
  }

  it('keeps the host default for no, floating, or unknown workspaces', async () => {
    const { runtime, selector } = makeRuntime([local])
    selector.mockRejectedValue(new Error('selector_not_found'))
    expect(await runtime.resolveAgentDetectionHost(undefined)).toEqual({ kind: 'local' })
    expect(await runtime.resolveAgentDetectionHost(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      kind: 'local'
    })
    expect(await runtime.resolveAgentDetectionHost('r1::C:\\gone')).toEqual({ kind: 'local' })
    expect(selector).toHaveBeenCalledTimes(1)
  })

  it('refuses a workspace id two hosts share instead of probing this one', async () => {
    const { runtime, selector } = makeRuntime([local])
    selector.mockRejectedValue(new Error('selector_ambiguous'))
    await expect(runtime.resolveAgentDetectionHost('r1::/srv/r1')).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it("routes by the host's own worktree record", async () => {
    const ssh: Repo = { ...local, path: '/srv/r1', executionHostId: 'ssh:build-host' }
    const { runtime, selector } = makeRuntime([ssh, local])
    selector.mockResolvedValueOnce(worktree({ repoId: 'r1', path: 'C:\\src\\r1', hostId: 'local' }))
    expect(await runtime.resolveAgentDetectionHost('r1::C:\\src\\r1')).toEqual({
      kind: 'local',
      context: {
        projectRuntime: {
          status: 'resolved',
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
        }
      }
    })
    expect(selector).toHaveBeenCalledWith('id:r1::C:\\src\\r1')
  })
})
