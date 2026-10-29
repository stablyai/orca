import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
const conversion = vi.hoisted(() => ({
  previewWslDriveProjectWindowsGit: vi.fn(async () => ({ blockers: [] })),
  convertWslDriveProjectToWindowsGit: vi.fn(async () => ({ ok: false, blockers: [] }))
}))
vi.mock('../wsl/wsl-drive-project-windows-git', () => conversion)
vi.mock('./wsl-drive-unc-conversion-handlers', () => ({
  registerWslDriveUncConversionHandlers: vi.fn()
}))

import { registerWslDriveProjectHandlers, readWorktreeLinks } from './wsl-drive-project-handlers'

const invoke = (channel: string, request?: unknown) => handlers.get(channel)?.({}, request)
const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setPlatform('win32')
  conversion.previewWslDriveProjectWindowsGit.mockClear()
  conversion.convertWslDriveProjectToWindowsGit.mockClear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The conversion is mocked; the handler only builds deps.
  registerWslDriveProjectHandlers({} as never, {} as never)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setPlatform(originalPlatform)
})

describe('WSL drive project IPC', () => {
  it('refuses with the gate closed or off Windows, before reading anything', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(invoke('wslDriveProject:preview', 'p1')).rejects.toThrow(
      'wsl_drive_project_unavailable'
    )
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    setPlatform('darwin')
    await expect(
      invoke('wslDriveProject:convert', { projectId: 'p1', alignLineEndings: true })
    ).rejects.toThrow('wsl_drive_project_unavailable')
    expect(conversion.previewWslDriveProjectWindowsGit).not.toHaveBeenCalled()
    expect(conversion.convertWslDriveProjectToWindowsGit).not.toHaveBeenCalled()
  })

  it('passes the project and an explicit line-ending opt-in only', async () => {
    await invoke('wslDriveProject:convert', { projectId: 'p1', alignLineEndings: 'yes' })
    expect(conversion.convertWslDriveProjectToWindowsGit).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      { alignLineEndings: false }
    )
    await expect(invoke('wslDriveProject:preview', '')).rejects.toThrow(
      'wsl_drive_project_invalid_args'
    )
  })
})

describe('readWorktreeLinks', () => {
  let commonDir: string
  beforeEach(() => {
    commonDir = mkdtempSync(join(tmpdir(), 'orca-wsl-drive-links-'))
  })
  afterEach(() => rmSync(commonDir, { recursive: true, force: true }))

  it('reads each linked worktree link and skips entries without one', async () => {
    mkdirSync(join(commonDir, 'worktrees', 'fix'), { recursive: true })
    writeFileSync(join(commonDir, 'worktrees', 'fix', 'gitdir'), '/home/me/trees/fix/.git\n')
    mkdirSync(join(commonDir, 'worktrees', 'broken'), { recursive: true })
    await expect(readWorktreeLinks(commonDir)).resolves.toEqual(['/home/me/trees/fix/.git'])
  })

  it('reads none for a repo with no linked worktrees', async () => {
    await expect(readWorktreeLinks(commonDir)).resolves.toEqual([])
  })
})
