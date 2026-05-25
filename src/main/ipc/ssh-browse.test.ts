import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSshBrowseHandler } from './ssh-browse'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

type BrowseHandler = (
  event: unknown,
  args: { targetId: string; dirPath: string }
) => Promise<unknown>

function createMockChannel(): EventEmitter & { stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter()
  })
}

describe('registerSshBrowseHandler', () => {
  let handler: BrowseHandler

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    handleMock.mockImplementation((_channel: string, registeredHandler: BrowseHandler) => {
      handler = registeredHandler
    })
  })

  it('bypasses remote ls aliases when listing a directory', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '~' })
    await Promise.resolve()
    channel.emit('data', Buffer.from('/home/user\nsrc/\nREADME.md\nnotes file.txt\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: '/home/user',
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'notes file.txt', isDirectory: false },
        { name: 'README.md', isDirectory: false }
      ]
    })
    expect(exec).toHaveBeenCalledWith('cd "$HOME" && pwd && command ls -1Ap')
  })

  it('escapes remote browse paths before invoking command ls', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: "/tmp/it's here" })
    await Promise.resolve()
    channel.emit('data', Buffer.from("/tmp/it's here\n"))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: "/tmp/it's here",
      entries: []
    })
    expect(exec).toHaveBeenCalledWith("cd '/tmp/it'\\''s here' && pwd && command ls -1Ap")
  })
})
