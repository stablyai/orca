import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, handler)
  }),
  on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    mocks.listeners.set(channel, listener)
  })
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, on: mocks.on }
}))

import { registerSideQuestHandlers } from './side-quest'
import {
  CodexAppServerTestProcess,
  initializeTestAppServer
} from '../side-quest/codex-app-server-test-process'

function createAppServer(): CodexAppServerTestProcess {
  return new CodexAppServerTestProcess((message, process) => {
    if (initializeTestAppServer(message, process)) {
      return
    }
    if (message.method === 'config/read') {
      process.send({ id: message.id, result: { config: { mcp_servers: {} } } })
      return
    }
    if (message.method === 'thread/start') {
      process.send({
        id: message.id,
        result: {
          thread: { id: 'thread-1', sessionId: 'thread-1', ephemeral: false, turns: [] }
        }
      })
    }
  })
}

describe('Side Quest IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.listeners.clear()
    vi.clearAllMocks()
  })

  it('broadcasts unscoped app-server failures to every active Side Quest', async () => {
    const process = createAppServer()
    const dispose = registerSideQuestHandlers({ processFactory: () => process.asProcess() })
    const create = mocks.handlers.get('sideQuest:create')
    const subscribe = mocks.listeners.get('sideQuest:subscribe')
    expect(create).toBeDefined()
    expect(subscribe).toBeDefined()

    const created = await create?.({}, { cwd: '/repo' })
    expect(created).toEqual({ providerThreadId: 'thread-1' })

    const sender = {
      id: 7,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      send: vi.fn()
    }
    const secondSender = {
      id: 8,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      send: vi.fn()
    }
    subscribe?.({ sender }, { subscriptionId: 'subscription-1', providerThreadId: 'thread-1' })
    subscribe?.(
      { sender: secondSender },
      { subscriptionId: 'subscription-2', providerThreadId: 'thread-1' }
    )
    process.send({
      method: 'item/agentMessage/delta',
      params: { turnId: 'turn-1', itemId: 'item-1', delta: 'Hello' }
    })

    expect(sender.send).toHaveBeenCalledWith('sideQuest:event', {
      subscriptionId: 'subscription-1',
      event: {
        type: 'error',
        providerThreadId: 'thread-1',
        message: 'Codex app-server response is missing threadId.'
      }
    })
    expect(secondSender.send).toHaveBeenCalledWith('sideQuest:event', {
      subscriptionId: 'subscription-2',
      event: {
        type: 'error',
        providerThreadId: 'thread-1',
        message: 'Codex app-server response is missing threadId.'
      }
    })
    dispose()
  })
})
