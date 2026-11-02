import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  readFile: vi.fn(),
  stat: vi.fn(),
  blocked: vi.fn<(path: string) => Promise<{ distro: string; state: 'stopped' } | null>>()
}))
vi.mock('../../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: mocks.blocked }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, stat: mocks.stat }))

import { registerWorktreeHookInspectionHandler } from './register-worktree-hook-inspection-handler'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const CONDUCTOR = JSON.stringify({ scripts: { setup: 'pnpm install' } })
const originalPlatform = process.platform

function eperm(path: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), {
    code: 'EPERM'
  })
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
}

describe('setup script import inspection of a UNC drive-mount project', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.blocked.mockResolvedValue(null)
    // WSL 2.7 refuses Windows access to a drive mount over UNC; the drive path opens.
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.startsWith('\\\\')) {
        throw eperm(path)
      }
      if (path === String.raw`C:\src\app\conductor.json`) {
        return CONDUCTOR
      }
      throw enoent(path)
    })
    mocks.stat.mockImplementation(async (path: string) => {
      throw path.startsWith('\\\\') ? eperm(path) : enoent(path)
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('reads the candidates through the drive path, without EPERM warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo: Partial<Repo> = { id: 'repo', path: UNC, kind: 'git', executionHostId: 'local' }
    const store = { getRepos: () => [repo], getRepo: () => repo }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler reads only these store accessors.
    registerWorktreeHookInspectionHandler({ store } as never)

    const candidates = await mocks.handlers.get('hooks:inspectSetupScriptImports')!(null, {
      repoId: 'repo'
    })

    expect(candidates).toEqual([expect.objectContaining({ provider: 'conductor' })])
    expect(mocks.readFile).toHaveBeenCalledWith(String.raw`C:\src\app\conductor.json`, 'utf-8')
    expect(mocks.readFile).not.toHaveBeenCalledWith(expect.stringMatching(/^\\\\/), 'utf-8')
    expect(warn).not.toHaveBeenCalled()
  })

  it('opens nothing in a stopped distro, so a background inspection cannot boot it (E9)', async () => {
    mocks.readFile.mockClear()
    mocks.stat.mockClear()
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const repo: Partial<Repo> = { id: 'repo', path: UNC, kind: 'git', executionHostId: 'local' }
    const store = { getRepos: () => [repo], getRepo: () => repo }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler reads only these store accessors.
    registerWorktreeHookInspectionHandler({ store } as never)

    const candidates = await mocks.handlers.get('hooks:inspectSetupScriptImports')!(null, {
      repoId: 'repo'
    })

    expect(candidates).toEqual([])
    expect(mocks.blocked).toHaveBeenCalledWith(UNC)
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})
