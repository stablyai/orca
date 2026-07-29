import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OsFileOpenRequests from '../startup/os-file-open-requests'

const handleMock = vi.fn()
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

const filterExistingFilesMock = vi.fn(async (paths: readonly string[]) => [...paths])
vi.mock('../startup/os-file-open-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof OsFileOpenRequests>()),
  filterExistingFiles: (paths: readonly string[]) => filterExistingFilesMock(paths)
}))

const { createOsFileOpenRequestQueue } = await import('../startup/os-file-open-requests')
const { registerOsFileOpenHandlers } = await import('./os-file-open')

function getHandler(channel: string): (event: unknown) => Promise<string[]> {
  const entry = handleMock.mock.calls.find(([name]) => name === channel)
  if (!entry) {
    throw new Error(`handler not registered: ${channel}`)
  }
  return entry[1]
}

function createFakeSender(): {
  send: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
  destroyedListenerCount: () => number
} {
  let destroyed = false
  let destroyHandlers: (() => void)[] = []
  return {
    send: vi.fn(),
    once: vi.fn((eventName: string, handler: () => void) => {
      if (eventName === 'destroyed') {
        destroyHandlers.push(handler)
      }
    }),
    removeListener: vi.fn((eventName: string, handler: () => void) => {
      if (eventName === 'destroyed') {
        destroyHandlers = destroyHandlers.filter((entry) => entry !== handler)
      }
    }),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      for (const handler of destroyHandlers.splice(0, destroyHandlers.length)) {
        handler()
      }
    },
    destroyedListenerCount: () => destroyHandlers.length
  }
}

describe('registerOsFileOpenHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    filterExistingFilesMock.mockClear()
  })

  it('drains queued paths and filters out ones that no longer exist', async () => {
    filterExistingFilesMock.mockResolvedValueOnce(['/Users/x/a.md'])
    const queue = createOsFileOpenRequestQueue()
    queue.enqueue('/Users/x/a.md')
    queue.enqueue('/Users/x/gone.md')
    registerOsFileOpenHandlers(queue)

    const sender = createFakeSender()
    const result = await getHandler('osFileOpen:takePending')({ sender })

    expect(filterExistingFilesMock).toHaveBeenCalledWith(['/Users/x/a.md', '/Users/x/gone.md'])
    expect(result).toEqual(['/Users/x/a.md'])
  })

  it('pushes later arrivals to the renderer that took the pending batch', async () => {
    const queue = createOsFileOpenRequestQueue()
    registerOsFileOpenHandlers(queue)

    const sender = createFakeSender()
    await getHandler('osFileOpen:takePending')({ sender })

    queue.enqueue('/Users/x/later.md')
    expect(sender.send).toHaveBeenCalledWith('osFileOpen:opened', '/Users/x/later.md')
  })

  it('stops pushing and resumes buffering after the renderer is destroyed', async () => {
    const queue = createOsFileOpenRequestQueue()
    registerOsFileOpenHandlers(queue)

    const sender = createFakeSender()
    await getHandler('osFileOpen:takePending')({ sender })
    sender.destroy()

    queue.enqueue('/Users/x/later.md')
    expect(sender.send).not.toHaveBeenCalled()
    expect(queue.drain()).toEqual(['/Users/x/later.md'])
  })

  it('does not accumulate destroyed listeners across repeated takePending calls', async () => {
    const queue = createOsFileOpenRequestQueue()
    registerOsFileOpenHandlers(queue)

    const sender = createFakeSender()
    const handler = getHandler('osFileOpen:takePending')
    await handler({ sender })
    await handler({ sender })

    expect(sender.destroyedListenerCount()).toBe(1)
  })
})
