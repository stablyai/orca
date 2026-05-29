import { EventEmitter } from 'events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const electronMocks = vi.hoisted(() => ({
  appGetPath: vi.fn(),
  dialogShowOpenDialog: vi.fn(),
  ipcHandle: vi.fn(),
  ipcRemoveHandler: vi.fn(),
  netRequest: vi.fn(),
  handlers: new Map<string, IpcHandler>()
}))

vi.mock('electron', () => ({
  app: { getPath: electronMocks.appGetPath },
  dialog: { showOpenDialog: electronMocks.dialogShowOpenDialog },
  ipcMain: {
    removeHandler: electronMocks.ipcRemoveHandler,
    handle: electronMocks.ipcHandle.mockImplementation((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler)
    })
  },
  net: { request: electronMocks.netRequest }
}))

vi.mock('adm-zip', () => ({ default: class MockAdmZip {} }))

import { registerIconThemeHandlers } from './icon-themes'

class FakeClientRequest extends EventEmitter {
  abort = vi.fn()
  end = vi.fn()
  followRedirect = vi.fn()
}

describe('icon theme IPC handlers', () => {
  let tempRoot: string
  let userDataDir: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-icon-themes-'))
    userDataDir = join(tempRoot, 'userData')
    await mkdir(userDataDir)

    electronMocks.handlers.clear()
    electronMocks.appGetPath.mockReturnValue(userDataDir)
    electronMocks.dialogShowOpenDialog.mockReset()
    electronMocks.ipcHandle.mockClear()
    electronMocks.ipcRemoveHandler.mockClear()
    electronMocks.netRequest.mockReset()
    registerIconThemeHandlers({} as never)
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('imports a local VS Code icon theme, inlines SVGs, and avoids builtin id collisions', async () => {
    const themeDir = join(tempRoot, 'default')
    await mkdir(join(themeDir, 'icons'), { recursive: true })
    await mkdir(join(themeDir, 'themes'), { recursive: true })
    await writeFile(
      join(themeDir, 'package.json'),
      JSON.stringify({
        contributes: { iconThemes: [{ id: 'local', label: 'Local', path: './themes/theme.json' }] }
      }),
      'utf8'
    )
    await writeFile(
      join(themeDir, 'themes', 'theme.json'),
      JSON.stringify({
        name: 'Local Theme',
        iconDefinitions: { _file: { iconPath: '../icons/file.svg' } },
        file: '_file'
      }),
      'utf8'
    )
    await writeFile(join(themeDir, 'icons', 'file.svg'), '<svg viewBox="0 0 1 1" />', 'utf8')

    electronMocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [themeDir]
    })

    const handler = electronMocks.handlers.get('icon-themes:pickAndImport')
    expect(handler).toBeDefined()
    const result = (await handler!({})) as {
      id: string
      json: { iconDefinitions: Record<string, { iconPath?: string }> }
    }

    expect(result.id).toBe('user-default')
    expect(result.json.iconDefinitions._file.iconPath).toMatch(/^data:image\/svg\+xml;base64,/)

    const persisted = JSON.parse(
      await readFile(join(userDataDir, 'icon-themes', 'user-default.json'), 'utf8')
    ) as { id: string }
    expect(persisted.id).toBe('user-default')
  })

  it('rejects package icon theme paths that escape the selected folder', async () => {
    const themeDir = join(tempRoot, 'malicious')
    await mkdir(themeDir, { recursive: true })
    await writeFile(
      join(tempRoot, 'outside-theme.json'),
      JSON.stringify({ iconDefinitions: { _file: {} }, file: '_file' }),
      'utf8'
    )
    await writeFile(
      join(themeDir, 'package.json'),
      JSON.stringify({
        contributes: {
          iconThemes: [{ id: 'escape', label: 'Escape', path: '../outside-theme.json' }]
        }
      }),
      'utf8'
    )
    electronMocks.dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [themeDir]
    })

    const handler = electronMocks.handlers.get('icon-themes:pickAndImport')
    await expect(handler!({})).rejects.toThrow(/escapes the selected folder/)
  })

  it('rejects marketplace download redirects outside the Open VSX allowlist', async () => {
    const request = new FakeClientRequest()
    electronMocks.netRequest.mockReturnValue(request)

    const handler = electronMocks.handlers.get('icon-themes:installFromMarketplace')
    const installPromise = handler!(
      {},
      {
        publisher: 'publisher',
        name: 'theme',
        displayName: 'Theme',
        downloadUrl: 'https://open-vsx.org/api/publisher/theme/file/publisher.theme-1.0.0.vsix'
      }
    )

    expect(electronMocks.netRequest).toHaveBeenCalledWith({
      url: 'https://open-vsx.org/api/publisher/theme/file/publisher.theme-1.0.0.vsix',
      method: 'GET',
      redirect: 'manual'
    })

    request.emit('redirect', 302, 'GET', 'https://example.com/theme.vsix', {})

    await expect(installPromise).rejects.toThrow(/redirect leaves Open VSX/)
    expect(request.followRedirect).not.toHaveBeenCalled()
  })
})
