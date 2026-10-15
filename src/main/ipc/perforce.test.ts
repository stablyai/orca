import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { registerPerforceHandlers } from './perforce'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  backendFor: vi.fn(),
  detect: vi.fn(async (cwd: string) => ({ isWorkspace: cwd.endsWith('ws') })),
  resolveRoot: vi.fn(async () => {
    throw new Error('Access denied: unknown repository or worktree path')
  })
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../perforce/perforce-ssh-backend', () => ({
  resolvePerforceBackend: (connectionId?: string) => {
    mocks.backendFor(connectionId)
    return { detect: mocks.detect }
  }
}))
vi.mock('../perforce/perforce-desktop-settings', () => ({
  runWithDesktopPerforceSettings: (_store: unknown, run: () => unknown) => run()
}))
vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: mocks.resolveRoot
}))
vi.mock('./perforce-description-generation', () => ({
  registerPerforceDescriptionGeneration: vi.fn()
}))

function detectFolder(args: unknown): Promise<unknown> {
  const handler = mocks.handlers.get('perforce:detectFolder')
  return Promise.resolve(handler?.({}, args))
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers reach the store only through the mocked modules.
  registerPerforceHandlers({} as Store)
})

describe('perforce:detectFolder', () => {
  it('checks a local folder that is not yet a project, without the registered-root gate', async () => {
    await expect(detectFolder({ folderPath: resolve('ws') })).resolves.toEqual({
      isWorkspace: true
    })
    expect(mocks.backendFor).toHaveBeenCalledWith(undefined)
    expect(mocks.resolveRoot).not.toHaveBeenCalled()
  })

  it('checks an SSH folder on its host', async () => {
    await detectFolder({ folderPath: '/srv/ws', connectionId: 'box' })
    expect(mocks.backendFor).toHaveBeenCalledWith('box')
    expect(mocks.detect).toHaveBeenCalledWith('/srv/ws')
  })

  it('refuses a relative or missing local path', async () => {
    await expect(detectFolder({ folderPath: 'ws' })).rejects.toThrow('absolute folder path')
    await expect(detectFolder({})).rejects.toThrow('absolute folder path')
    expect(mocks.detect).not.toHaveBeenCalled()
  })
})
