import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  showSaveDialog: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('node:fs/promises', () => ({ ...mocks, writeFile: vi.fn() }))
vi.mock('./filesystem-download-folder', () => ({
  registerFilesystemDownloadFolderHandlers: vi.fn()
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({ requireSshFilesystemProvider: vi.fn() }))

import { createFilesystemHandlerContext } from './filesystem/filesystem-handler-context'
import { registerFilesystemDownloadHandlers } from './filesystem/filesystem-download-handlers'
import { DOWNLOAD_SESSION_TTL_MS } from './filesystem/filesystem-download-promotion'

const destination = resolve('fake-downloads', 'file.txt')
const lifetimeEvents = ['destroyed', 'render-process-gone', 'did-navigate'] as const
const senders: EventEmitter[] = []
let context: ReturnType<typeof createFilesystemHandlerContext>

function makeSender(id = 1) {
  const sender = Object.assign(new EventEmitter(), { id, isDestroyed: vi.fn(() => false) })
  sender.setMaxListeners(0)
  senders.push(sender)
  return sender
}

function makeHandle() {
  return { close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }
}

function invoke(name: string, sender: ReturnType<typeof makeSender>, args: unknown) {
  const handler = mocks.handlers.get(`fs:${name}`)
  if (!handler) {
    throw new Error(`Missing handler: ${name}`)
  }
  return handler({ sender }, args)
}

async function start(sender: ReturnType<typeof makeSender>) {
  const result = await invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
  if (
    !result ||
    typeof result !== 'object' ||
    !('transferId' in result) ||
    typeof result.transferId !== 'string'
  ) {
    throw new Error('Download did not start')
  }
  return result.transferId
}

function expectNoListeners(sender: ReturnType<typeof makeSender>) {
  for (const event of lifetimeEvents) {
    expect(sender.listenerCount(event)).toBe(0)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  mocks.handlers.clear()
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
  mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.open.mockImplementation(async () => makeHandle())
  mocks.rename.mockResolvedValue(undefined)
  mocks.rm.mockResolvedValue(undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Download handlers never access the store; unrelated handlers are not registered.
  const store = {} as Store
  const cancellations = { begin: () => null, finish: () => {}, cancel: () => {} }
  context = createFilesystemHandlerContext(store, undefined, cancellations, cancellations)
  registerFilesystemDownloadHandlers(context)
})

afterEach(async () => {
  await Promise.all(
    [...context.downloadSessions.keys()].map((id) => context.closeDownloadSession(id, true))
  )
  for (const sender of senders.splice(0)) {
    sender.removeAllListeners()
  }
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('chunked download renderer ownership', () => {
  it('releases all renderer listeners after twenty alternating finish and cancel calls', async () => {
    const sender = makeSender()
    for (let index = 0; index < 20; index += 1) {
      const transferId = await start(sender)
      await invoke(index % 2 ? 'finishDownloadedFile' : 'cancelDownloadedFile', sender, {
        transferId
      })
    }
    expect(context.downloadSessions.size).toBe(0)
    expectNoListeners(sender)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not open a dialog for an already destroyed renderer', async () => {
    const sender = makeSender()
    sender.isDestroyed.mockReturnValue(true)
    await expect(
      invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
    ).resolves.toEqual({ canceled: true })
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expectNoListeners(sender)
  })

  it.each(
    lifetimeEvents.flatMap((event) =>
      (['dialog', 'stat', 'open'] as const).map((phase) => ({ event, phase }))
    )
  )('cancels pending $phase work after $event', async ({ event, phase }) => {
    const sender = makeSender()
    const held = Promise.withResolvers<unknown>()
    const operation =
      phase === 'dialog' ? mocks.showSaveDialog : phase === 'stat' ? mocks.stat : mocks.open
    const callsBefore = operation.mock.calls.length
    const opensBefore = mocks.open.mock.calls.length
    operation.mockReturnValueOnce(held.promise)
    const pending = invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(callsBefore + 1))
    sender.emit(event)
    expectNoListeners(sender)
    const handle = makeHandle()
    held.resolve(
      phase === 'dialog'
        ? { canceled: false, filePath: destination }
        : phase === 'stat'
          ? { isDirectory: () => false }
          : handle
    )
    await expect(pending).resolves.toEqual({ canceled: true })
    expect(context.downloadSessions.size).toBe(0)
    expect(handle.close).toHaveBeenCalledTimes(phase === 'open' ? 1 : 0)
    expect(mocks.open).toHaveBeenCalledTimes(opensBefore + (phase === 'open' ? 1 : 0))
    if (phase === 'open') {
      expect(mocks.rm).toHaveBeenCalledWith(mocks.open.mock.calls.at(-1)?.[0], { force: true })
    }
    expectNoListeners(sender)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['dialog', 'stat', 'open'] as const)(
    'releases ownership when %s rejects',
    async (phase) => {
      const sender = makeSender()
      const error = new Error(`${phase} failed`)
      const operation =
        phase === 'dialog' ? mocks.showSaveDialog : phase === 'stat' ? mocks.stat : mocks.open
      operation.mockRejectedValueOnce(error)
      await expect(
        invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
      ).rejects.toBe(error)
      expectNoListeners(sender)
      expect(context.downloadSessions.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('releases ownership when the user cancels the dialog', async () => {
    const sender = makeSender()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(
      invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
    ).resolves.toEqual({ canceled: true })
    expectNoListeners(sender)
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each(lifetimeEvents)(
    'closes only live sessions owned by the renderer on %s',
    async (event) => {
      const first = makeSender(1),
        second = makeSender(2)
      const handles = [makeHandle(), makeHandle(), makeHandle()]
      for (const handle of handles) {
        mocks.open.mockResolvedValueOnce(handle)
      }
      const firstId = await start(first),
        secondId = await start(first),
        otherId = await start(second)
      first.emit(event)
      await vi.waitFor(() => expect(mocks.rm).toHaveBeenCalledTimes(2))
      expect([...context.downloadSessions.keys()]).toEqual([otherId])
      expect(handles[0].close).toHaveBeenCalledOnce()
      expect(handles[1].close).toHaveBeenCalledOnce()
      expect(handles[2].close).not.toHaveBeenCalled()
      expectNoListeners(first)
      await invoke('cancelDownloadedFile', first, { transferId: firstId })
      await invoke('cancelDownloadedFile', first, { transferId: secondId })
      expect(handles[0].close).toHaveBeenCalledOnce()
      expect(handles[1].close).toHaveBeenCalledOnce()
    }
  )

  it('keeps a concurrent session owned after its sibling finishes', async () => {
    const sender = makeSender(),
      firstHandle = makeHandle(),
      secondHandle = makeHandle()
    mocks.open.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle)
    const firstId = await start(sender),
      secondId = await start(sender)
    await invoke('finishDownloadedFile', sender, { transferId: firstId })
    sender.emit('destroyed')
    await vi.waitFor(() => expect(secondHandle.close).toHaveBeenCalledOnce())
    expect(context.downloadSessions.has(secondId)).toBe(false)
    expect(firstHandle.close).toHaveBeenCalledOnce()
    expectNoListeners(sender)
  })

  it.each(['did-start-navigation', 'did-navigate-in-page'])(
    'keeps a live document transfer across %s',
    async (event) => {
      const sender = makeSender(),
        transferId = await start(sender)
      sender.emit(event)
      expect(context.downloadSessions.has(transferId)).toBe(true)
      await invoke('appendDownloadedFileChunk', sender, {
        transferId,
        contentBase64: Buffer.from('bytes').toString('base64')
      })
      const handle = context.downloadSessions.get(transferId)?.handle
      expect(handle?.writeFile).toHaveBeenCalledWith(Buffer.from('bytes'))
    }
  )

  it('does not cancel a replacement sender with the same numeric id', async () => {
    const oldSender = makeSender(7),
      replacement = makeSender(7)
    await start(oldSender)
    const current = await start(replacement)
    oldSender.emit('destroyed')
    expect(context.downloadSessions.has(current)).toBe(true)
    expect(context.downloadSessions.size).toBe(1)
    expectNoListeners(oldSender)
  })

  it('does not let a late old-document open affect a replacement download', async () => {
    const sender = makeSender(),
      late = makeHandle(),
      current = makeHandle()
    const held = Promise.withResolvers<ReturnType<typeof makeHandle>>()
    mocks.open.mockReturnValueOnce(held.promise).mockResolvedValueOnce(current)
    const pending = invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    sender.emit('did-navigate')
    const transferId = await start(sender)
    held.resolve(late)
    await expect(pending).resolves.toEqual({ canceled: true })
    expect([...context.downloadSessions.keys()]).toEqual([transferId])
    expect(late.close).toHaveBeenCalledOnce()
    expect(current.close).not.toHaveBeenCalled()
    await invoke('finishDownloadedFile', sender, { transferId })
    expect(current.close).toHaveBeenCalledOnce()
    expectNoListeners(sender)
  })

  it('cleans a late temporary path even if handle close and removal both fail', async () => {
    const sender = makeSender(),
      handle = makeHandle()
    const held = Promise.withResolvers<ReturnType<typeof makeHandle>>()
    handle.close.mockRejectedValueOnce(new Error('close failed'))
    mocks.open.mockReturnValueOnce(held.promise)
    mocks.rm.mockRejectedValueOnce(new Error('remove failed'))
    const pending = invoke('startDownloadedFile', sender, { suggestedName: 'file.txt' })
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    sender.emit('destroyed')
    held.resolve(handle)
    await expect(pending).resolves.toEqual({ canceled: true })
    expectNoListeners(sender)
    expect(handle.close).toHaveBeenCalledOnce()
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(mocks.open.mock.calls[0][0], { force: true })
    expect(context.downloadSessions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases owner listeners before waiting for a canceled handle to close', async () => {
    const sender = makeSender(),
      handle = makeHandle(),
      held = Promise.withResolvers<void>()
    handle.close.mockReturnValueOnce(held.promise)
    mocks.open.mockResolvedValueOnce(handle)
    const transferId = await start(sender)
    const pending = invoke('cancelDownloadedFile', sender, { transferId })
    try {
      expectNoListeners(sender)
      expect(context.downloadSessions.size).toBe(0)
      sender.emit('destroyed')
      expect(handle.close).toHaveBeenCalledOnce()
    } finally {
      held.resolve()
      await pending
    }
  })

  it('releases ownership on timeout and does not close again after later owner events', async () => {
    const sender = makeSender(),
      handle = makeHandle()
    mocks.open.mockResolvedValueOnce(handle)
    await start(sender)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_TTL_MS)
    expectNoListeners(sender)
    expect(context.downloadSessions.size).toBe(0)
    expect(handle.close).toHaveBeenCalledOnce()
    expect(mocks.rm).toHaveBeenCalledOnce()
    sender.emit('destroyed')
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('keeps ownership cleanup when promotion fails or handle close rejects', async () => {
    const sender = makeSender(),
      handle = makeHandle()
    handle.close.mockRejectedValueOnce(new Error('close failed'))
    mocks.open.mockResolvedValueOnce(handle)
    mocks.rename.mockRejectedValueOnce(new Error('promotion failed'))
    const transferId = await start(sender)
    await expect(invoke('finishDownloadedFile', sender, { transferId })).rejects.toThrow(
      'promotion failed'
    )
    expectNoListeners(sender)
    expect(mocks.rm).toHaveBeenCalledOnce()
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
