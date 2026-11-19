import { describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import type { Repo } from '../../../shared/repository/repo-types'
import { registerRepoFolderPickerHandlers } from './repo-folder-picker-handlers'

const { handlers, showDialog } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<unknown>>(),
  showDialog: vi.fn(async (_options: unknown) => ({ canceled: true, filePaths: [] }))
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler)
  }
}))
vi.mock('../dialogs/single-flight-open-dialog', () => ({ showSingleFlightOpenDialog: showDialog }))

function repo(path: string, addedAt: number, connectionId: string | null = null): Repo {
  return { id: path, path, displayName: path, badgeColor: '#000000', addedAt, connectionId }
}

describe('repo folder pickers', () => {
  it('open beside the newest local project, ignoring newer remote projects', async () => {
    const repos = [
      repo('/Users/me/old/alpha', 1),
      repo('/Users/me/code/beta', 2),
      repo('/home/me/remote/gamma', 3, 'ssh-box')
    ]
    registerRepoFolderPickerHandlers(new BrowserWindow(), { getRepos: () => repos })

    for (const channel of ['repos:pickFolder', 'repos:pickFolders', 'repos:pickDirectory']) {
      showDialog.mockClear()
      await handlers.get(channel)!()
      expect(showDialog.mock.calls[0]?.[0]).toMatchObject({ defaultPath: '/Users/me/code' })
    }
  })
})
