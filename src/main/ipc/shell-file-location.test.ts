import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { handlers, openPath, stat, openAtLocation } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  openPath: vi.fn(),
  stat: vi.fn(),
  openAtLocation: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  shell: { openPath },
  dialog: {}
}))
vi.mock('node:fs/promises', () => ({ constants: { COPYFILE_EXCL: 1 }, stat, copyFile: vi.fn() }))
vi.mock('../default-editor-file-location', () => ({ openDefaultEditorAtLocation: openAtLocation }))

import { registerShellHandlers } from './shell'

describe('shell file location forwarding', () => {
  const filePath = resolve('project with spaces/日本語.ts')
  const location = { line: 551, column: 7 }

  beforeEach(() => {
    vi.resetAllMocks()
    handlers.clear()
    stat.mockResolvedValue({ isDirectory: () => false })
    openPath.mockResolvedValue('')
    openAtLocation.mockResolvedValue(true)
    registerShellHandlers({ getSshTarget: () => undefined })
  })

  async function open(channel: string, target: string, owner: unknown = 'local'): Promise<unknown> {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`Missing ${channel}`)
    }
    return handler({}, target, owner, location)
  }

  it.each(['path', 'uri'])('forwards the location after validating the %s target', async (kind) => {
    await open(
      kind === 'path' ? 'shell:openFilePath' : 'shell:openFileUri',
      kind === 'path' ? filePath : pathToFileURL(filePath).href
    )
    expect(stat).toHaveBeenCalledWith(filePath)
    expect(openAtLocation).toHaveBeenCalledWith(filePath, location)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('uses the OS default if the associated app cannot open a location', async () => {
    openAtLocation.mockResolvedValue(false)
    await expect(open('shell:openFilePath', filePath)).resolves.toBe(true)
    expect(openPath).toHaveBeenCalledWith(filePath)
  })

  it.each(['ssh:ssh-1', 'runtime:env-1', undefined])(
    'refuses non-local owner %s',
    async (owner) => {
      const pathHandler = handlers.get('shell:openFilePath')
      const uriHandler = handlers.get('shell:openFileUri')
      await expect(pathHandler?.({}, filePath, owner, location)).resolves.toBe(false)
      await uriHandler?.({}, pathToFileURL(filePath).href, owner, location)
      expect(stat).not.toHaveBeenCalled()
      expect(openAtLocation).not.toHaveBeenCalled()
      expect(openPath).not.toHaveBeenCalled()
    }
  )

  it('refuses missing files before looking up an editor', async () => {
    stat.mockRejectedValue(new Error('ENOENT'))
    await expect(open('shell:openFilePath', filePath)).resolves.toBe(false)
    expect(openAtLocation).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('refuses relative paths before looking up an editor', async () => {
    await expect(open('shell:openFilePath', 'relative.ts')).resolves.toBe(false)
    expect(openAtLocation).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })
})
