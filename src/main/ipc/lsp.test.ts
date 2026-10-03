import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const ports: {
    on: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    postMessage: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }[] = []
  return { handlers: new Map<string, (event: unknown, args: unknown) => unknown>(), ports }
})
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(name, handler),
    removeHandler: vi.fn()
  },
  MessageChannelMain: class {
    port1 = { on: vi.fn(), start: vi.fn(), postMessage: vi.fn(), close: vi.fn() }
    port2 = { on: vi.fn(), start: vi.fn(), postMessage: vi.fn(), close: vi.fn() }
    constructor() {
      mocks.ports.push(this.port1, this.port2)
    }
  }
}))

import { registerLspHandlers } from './lsp'

describe('lsp:open', () => {
  const attachPort = vi.fn()
  const acquire = vi.fn()
  const sender = { postMessage: vi.fn(), isDestroyed: vi.fn(() => false) }
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.ports.length = 0
    vi.clearAllMocks()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerLspHandlers only calls acquire on the manager.
    registerLspHandlers({ acquire } as never, { getRepo: () => undefined } as never)
  })

  it('returns the refusal and sends no port when LSP is off', async () => {
    acquire.mockResolvedValue({ ok: false, reason: 'disabled' })
    const result = await mocks.handlers.get('lsp:open')?.(
      { sender },
      { requestId: 'q', worktreeId: 'r::/p', languageId: 'ruby' }
    )
    expect(result).toEqual({ ok: false, reason: 'disabled' })
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it('attaches one end and transfers the other to the renderer', async () => {
    acquire.mockResolvedValue({ ok: true, key: 'k', session: { attachPort } })
    const result = await mocks.handlers.get('lsp:open')?.(
      { sender },
      { requestId: 'q', worktreeId: 'r::/p', languageId: 'ruby' }
    )
    expect(result).toEqual({ ok: true, sessionKey: 'k' })
    expect(attachPort).toHaveBeenCalledTimes(1)
    expect(sender.postMessage).toHaveBeenCalledWith('lsp:port', { requestId: 'q' }, [
      mocks.ports[1]
    ])
  })

  it('returns unavailable and attaches nothing when the port post throws', async () => {
    acquire.mockResolvedValue({ ok: true, key: 'k', session: { attachPort } })
    sender.postMessage.mockImplementationOnce(() => {
      throw new Error('gone')
    })
    const result = await mocks.handlers.get('lsp:open')?.(
      { sender },
      { requestId: 'q', worktreeId: 'r::/p', languageId: 'ruby' }
    )
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(attachPort).not.toHaveBeenCalled()
  })

  it('returns unavailable when the sender was destroyed during acquire', async () => {
    acquire.mockResolvedValue({ ok: true, key: 'k', session: { attachPort } })
    sender.isDestroyed.mockReturnValueOnce(true)
    const result = await mocks.handlers.get('lsp:open')?.(
      { sender },
      { requestId: 'q', worktreeId: 'r::/p', languageId: 'ruby' }
    )
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(sender.postMessage).not.toHaveBeenCalled()
    expect(attachPort).not.toHaveBeenCalled()
  })

  it('rejects malformed arguments', async () => {
    const result = await mocks.handlers.get('lsp:open')?.({ sender }, { worktreeId: 1 })
    expect(result).toEqual({ ok: false, reason: 'invalid-worktree' })
    expect(acquire).not.toHaveBeenCalled()
  })
})
