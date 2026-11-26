import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import { createFakeCopilotServer } from '../copilot-inline-completion/fake-copilot-server-fixture'
import { registerCopilotInlineCompletionHandlers } from './copilot-inline-completion'

class Sender extends EventEmitter {
  mainFrame = { detached: false }
  isDestroyed() {
    return false
  }
}

type Invoke = (
  event: { sender: Sender; senderFrame: Sender['mainFrame'] },
  args: unknown
) => unknown
const { handlers, locate, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, Invoke>(),
  locate: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1', on: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: Invoke) => handlers.set(name, handler)
  },
  webContents: { getAllWebContents: () => [] },
  clipboard: {},
  shell: {}
}))
vi.mock('../copilot-inline-completion/copilot-server-process', () => ({
  createCopilotServerLocator: () => locate,
  spawnCopilotServer: spawn,
  terminateCopilotServer: (child: { kill(): void }) => child.kill()
}))
vi.mock('./filesystem/access/filesystem-auth', () => ({
  resolveAuthorizedPath: async (path: string) => path
}))

const args = { rootPath: '/repo', filePath: '/repo/a.ts', text: 'hello', languageId: 'typescript' }
function invoke(sender: Sender, channel: string, payload: unknown) {
  const handler = handlers.get(`copilotCompletion:${channel}`)
  if (!handler) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return handler({ sender, senderFrame: sender.mainFrame }, payload)
}

describe('Copilot renderer document lifetime', () => {
  beforeEach(() => {
    locate.mockResolvedValue('/copilot')
    // The only consumer of the store is the mocked path authorizer.
    const store: Store = Object.create(null)
    registerCopilotInlineCompletionHandlers(store)
  })
  afterEach(() => {
    vi.useRealTimers()
    handlers.clear()
  })

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    'drops all sender references on %s and lets the last document idle out',
    async (event) => {
      const fake = createFakeCopilotServer({ checkStatus: { status: 'OK', user: 'octocat' } })
      spawn.mockReturnValue(fake.child)
      const first = new Sender()
      const second = new Sender()
      const opened = await invoke(first, 'openDocument', args)
      await invoke(first, 'openDocument', args)
      await invoke(first, 'openDocument', { ...args, filePath: '/repo/b.ts' })
      await invoke(second, 'openDocument', args)
      const closes = () => fake.received.filter((m) => m.method === 'textDocument/didClose')
      first.emit(event)
      expect(closes()).toHaveLength(1)
      expect(closes()[0].params).toMatchObject({
        textDocument: { uri: expect.stringMatching(/b\.ts$/) }
      })
      await invoke(first, 'closeDocument', opened)
      expect(closes()).toHaveLength(1)
      vi.useFakeTimers()
      second.emit(event)
      expect(closes()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(180_000)
      expect(fake.child.kill).toHaveBeenCalledOnce()
    }
  )

  it('abandons a pending open after reload and allows the replacement document to open the same URI', async () => {
    const fake = createFakeCopilotServer()
    spawn.mockReturnValue(fake.child)
    const sender = new Sender()
    const pending = invoke(sender, 'openDocument', args)
    const check = await fake.waitFor((m) => m.method === 'checkStatus')
    sender.emit('did-navigate')
    const next = invoke(sender, 'openDocument', args)
    fake.reply(check.id, { status: 'OK', user: 'octocat' })
    await expect(pending).resolves.toEqual({ fileUri: null })
    const opened = await next
    expect(fake.received.filter((m) => m.method === 'textDocument/didOpen')).toHaveLength(1)
    await invoke(sender, 'closeDocument', opened)
    expect(fake.received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(1)
  })
})
