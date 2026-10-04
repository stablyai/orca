import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const { startNotebookKernelMock, resolveAuthorizedPathMock } = vi.hoisted(() => ({
  startNotebookKernelMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('./filesystem-auth', () => ({ resolveAuthorizedPath: resolveAuthorizedPathMock }))
vi.mock('../notebook/notebook-kernel', () => ({ startNotebookKernel: startNotebookKernelMock }))

import { registerNotebookHandlers } from './notebook'
import type { Store } from '../persistence'

function fakeKernel() {
  let onFrame: (frame: KernelFrame) => void = () => {}
  const exited = Promise.withResolvers<void>()
  const kernel = { execute: vi.fn(), interrupt: vi.fn(), shutdown: vi.fn() }
  startNotebookKernelMock.mockImplementationOnce((options) => {
    onFrame = options.onFrame
    return { kernel, ready: Promise.resolve({ status: 'ready' }), exited: exited.promise }
  })
  return { kernel, emit: (frame: KernelFrame) => onFrame(frame), exit: () => exited.resolve() }
}

let nextOwnerId = 0
const owners: EventEmitter[] = []

function fakeOwner() {
  const owner = Object.assign(new EventEmitter(), {
    id: ++nextOwnerId,
    send: vi.fn(),
    isDestroyed: (): boolean => false
  })
  owners.push(owner)
  return owner
}

afterEach(() => {
  for (const owner of owners) {
    owner.emit('destroyed')
  }
  owners.length = 0
})

describe('notebook IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.resetAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => `/real${path}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only pass the store to the mocked authorizer.
    registerNotebookHandlers({} as Store)
  })

  it('starts one kernel per notebook in its folder and routes its frames to the owning window', async () => {
    const first = fakeKernel()
    const owner = fakeOwner()
    const start = handlers.get('notebook:startKernel')!
    await expect(
      start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    ).resolves.toEqual({ status: 'ready' })
    expect(startNotebookKernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ python: '/py', cwd: '/real/repo' })
    )

    await handlers.get('notebook:execute')!(
      { sender: owner },
      { filePath: '/repo/nb.ipynb', code: 'x' }
    )
    expect(first.kernel.execute).toHaveBeenCalledWith('x')
    first.emit({ type: 'done', status: 'ok', execution_count: 1 })
    expect(owner.send).toHaveBeenCalledWith('notebook:kernelFrame', {
      filePath: '/repo/nb.ipynb',
      frame: { type: 'done', status: 'ok', execution_count: 1 }
    })

    fakeKernel()
    await start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    expect(first.kernel.shutdown).toHaveBeenCalledOnce()
  })

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    'shuts down a renderer’s kernels on %s',
    async (lifecycleEvent) => {
      const { kernel } = fakeKernel()
      const owner = fakeOwner()
      await handlers.get('notebook:startKernel')!(
        { sender: owner },
        { filePath: '/repo/nb.ipynb', python: '/py' }
      )
      owner.emit(lifecycleEvent)
      expect(kernel.shutdown).toHaveBeenCalledOnce()
      await handlers.get('notebook:execute')!(
        { sender: owner },
        { filePath: '/repo/nb.ipynb', code: 'x' }
      )
      expect(kernel.execute).not.toHaveBeenCalled()
    }
  )

  it('keeps each window’s kernel for the same notebook separate', async () => {
    const first = fakeKernel()
    const second = fakeKernel()
    const [a, b] = [fakeOwner(), fakeOwner()]
    const start = handlers.get('notebook:startKernel')!
    await start({ sender: a }, { filePath: '/repo/nb.ipynb', python: '/py' })
    await start({ sender: b }, { filePath: '/repo/nb.ipynb', python: '/py' })
    expect(first.kernel.shutdown).not.toHaveBeenCalled()
    await handlers.get('notebook:execute')!(
      { sender: b },
      { filePath: '/repo/nb.ipynb', code: 'x' }
    )
    expect(second.kernel.execute).toHaveBeenCalledWith('x')
    expect(first.kernel.execute).not.toHaveBeenCalled()
  })

  it.each(['shutdown', 'destroyed', 'did-navigate', 'render-process-gone'])(
    'does not start a kernel after %s while path authorization is pending',
    async (boundary) => {
      const authorization = Promise.withResolvers<string>()
      resolveAuthorizedPathMock.mockReturnValueOnce(authorization.promise)
      fakeKernel()
      const owner = fakeOwner()
      const args = { filePath: '/repo/nb.ipynb', python: '/py' }
      const pending = handlers.get('notebook:startKernel')!({ sender: owner }, args)
      if (boundary === 'shutdown') {
        handlers.get('notebook:shutdownKernel')!({ sender: owner }, args)
      } else {
        owner.emit(boundary)
      }
      authorization.resolve('/real/repo/nb.ipynb')

      await expect(pending).resolves.toMatchObject({ status: 'failed' })
      expect(startNotebookKernelMock).not.toHaveBeenCalled()
      expect(owner.listenerCount('did-navigate')).toBe(boundary === 'shutdown' ? 1 : 0)
    }
  )

  it('refuses a renderer that was already destroyed before invocation', async () => {
    fakeKernel()
    const owner = fakeOwner()
    owner.isDestroyed = () => true

    await expect(
      handlers.get('notebook:startKernel')!(
        { sender: owner },
        { filePath: '/repo/nb.ipynb', python: '/py' }
      )
    ).resolves.toMatchObject({ status: 'failed' })
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
    expect(startNotebookKernelMock).not.toHaveBeenCalled()
  })

  it('keeps a reopened pending start cancellable after the old start finishes', async () => {
    const oldAuthorization = Promise.withResolvers<string>()
    const freshAuthorization = Promise.withResolvers<string>()
    resolveAuthorizedPathMock
      .mockReturnValueOnce(oldAuthorization.promise)
      .mockReturnValueOnce(freshAuthorization.promise)
    fakeKernel()
    fakeKernel()
    const owner = fakeOwner()
    const args = { filePath: '/repo/nb.ipynb', python: '/py' }
    const start = handlers.get('notebook:startKernel')!
    const shutdown = handlers.get('notebook:shutdownKernel')!
    const old = start({ sender: owner }, args)
    shutdown({ sender: owner }, args)
    const fresh = start({ sender: owner }, args)
    oldAuthorization.resolve('/real/repo/nb.ipynb')
    await expect(old).resolves.toMatchObject({ status: 'failed' })
    shutdown({ sender: owner }, args)
    freshAuthorization.resolve('/real/repo/nb.ipynb')

    await expect(fresh).resolves.toMatchObject({ status: 'failed' })
    expect(startNotebookKernelMock).not.toHaveBeenCalled()
    expect(owner.listenerCount('did-navigate')).toBe(1)
  })

  it.each([0, 1])(
    'preserves concurrent authorization order %s and ignores a replaced kernel exit',
    async (firstIndex) => {
      const authorizations = [Promise.withResolvers<string>(), Promise.withResolvers<string>()]
      resolveAuthorizedPathMock
        .mockReturnValueOnce(authorizations[0].promise)
        .mockReturnValueOnce(authorizations[1].promise)
      const firstConstructed = fakeKernel()
      const lastConstructed = fakeKernel()
      const owner = fakeOwner()
      const start = handlers.get('notebook:startKernel')!
      const args = { filePath: '/repo/nb.ipynb', python: '/py' }
      const pending = [start({ sender: owner }, args), start({ sender: owner }, args)]
      authorizations[firstIndex].resolve('/real/repo/nb.ipynb')
      await expect(pending[firstIndex]).resolves.toEqual({ status: 'ready' })
      authorizations[1 - firstIndex].resolve('/real/repo/nb.ipynb')
      await expect(pending[1 - firstIndex]).resolves.toEqual({ status: 'ready' })
      expect(firstConstructed.kernel.shutdown).toHaveBeenCalledOnce()
      expect(lastConstructed.kernel.shutdown).not.toHaveBeenCalled()
      firstConstructed.exit()
      await Promise.resolve()

      handlers.get('notebook:execute')!(
        { sender: owner },
        { filePath: args.filePath, code: 'current' }
      )
      expect(lastConstructed.kernel.execute).toHaveBeenCalledWith('current')
      expect(firstConstructed.kernel.execute).not.toHaveBeenCalled()
    }
  )

  it('cancels one raw alias without canceling the canonical path’s pending start', async () => {
    const aliasAuthorization = Promise.withResolvers<string>()
    const canonicalAuthorization = Promise.withResolvers<string>()
    resolveAuthorizedPathMock
      .mockReturnValueOnce(aliasAuthorization.promise)
      .mockReturnValueOnce(canonicalAuthorization.promise)
    const current = fakeKernel()
    const owner = fakeOwner()
    const start = handlers.get('notebook:startKernel')!
    const alias = { filePath: '/tmp/repo/nb.ipynb', python: '/py' }
    const canonical = { filePath: '/private/tmp/repo/nb.ipynb', python: '/py' }
    const old = start({ sender: owner }, alias)
    const fresh = start({ sender: owner }, canonical)
    handlers.get('notebook:shutdownKernel')!({ sender: owner }, alias)
    aliasAuthorization.resolve(canonical.filePath)
    await expect(old).resolves.toMatchObject({ status: 'failed' })
    canonicalAuthorization.resolve(canonical.filePath)

    await expect(fresh).resolves.toEqual({ status: 'ready' })
    handlers.get('notebook:execute')!({ sender: owner }, { ...canonical, code: 'canonical' })
    expect(current.kernel.execute).toHaveBeenCalledWith('canonical')
    expect(current.kernel.shutdown).not.toHaveBeenCalled()
    expect(startNotebookKernelMock).toHaveBeenCalledOnce()
  })
})
