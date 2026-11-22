import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { registerRuntimeHandlers } from '../runtime'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle, on: vi.fn(), removeAllListeners: vi.fn(), removeHandler: vi.fn() }
}))

beforeEach(() => {
  handle.mockClear()
})

it.each(['did-navigate', 'destroyed'] as const)(
  'revokes an accepted desktop restart before retirement on %s',
  async (event) => {
    const runtime = new OrcaRuntimeService()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stop = vi.fn()
    vi.spyOn(runtime, 'startWindowTabTerminal').mockImplementation(
      async (_worktree, _pane, opts) => {
        entered.resolve()
        await release.promise
        if (opts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        stop()
        return { handle: 'different-shell', worktreeId: 'workspace', title: null }
      }
    )
    registerRuntimeHandlers(runtime)
    const run = handle.mock.calls.find(([channel]) => channel === 'runtime:call')![1]
    const frame = {}
    const sender = Object.assign(new EventEmitter(), { id: 14, mainFrame: frame })
    const pane = {
      worktreeId: 'workspace',
      tabId: 'window-tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      tabCreatedAt: 1
    }
    const result: Promise<unknown> = run(
      { sender, senderFrame: frame },
      {
        method: 'terminal.create',
        params: {
          worktree: 'id:workspace',
          tabId: pane.tabId,
          leafId: pane.leafId,
          windowTab: true,
          accountRestart: {
            requestId: 'restart-request',
            attemptId: 'restart-attempt',
            hostEpoch: 'host-epoch',
            pane,
            expected: {
              kind: 'endpoint',
              ptyId: 'old-pty',
              incarnationId: 'old-incarnation',
              bindingGeneration: 1
            }
          }
        }
      }
    )
    try {
      await Promise.race([
        entered.promise,
        result.then((reply) => {
          throw new Error(`Restart never reached the window spawn: ${JSON.stringify(reply)}`)
        })
      ])
      sender.emit(event)
    } finally {
      release.resolve()
    }
    expect(await result).toMatchObject({ ok: false })
    expect(stop).not.toHaveBeenCalled()
  }
)
