import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AgentHookServerModule from '../agent-hooks/server'

// Why: cover the agentStatus:drop IPC handler — it must propagate the
// renderer dismissal to dropStatusEntry so the on-disk last-status file
// evicts the entry.

const dropStatusEntry = vi.fn()
const getStatusSnapshot = vi.fn()
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const removeHandler = vi.fn()
const removeAllListeners = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      onHandlers.set(channel, handler)
    },
    removeHandler,
    removeAllListeners
  }
}))

vi.mock('../agent-hooks/server', async () => {
  // Why: import the real isValidPaneKey so this test stays in sync with any
  // tightening of the validator (length cap, character allow-list, etc).
  const actual = await vi.importActual<typeof AgentHookServerModule>('../agent-hooks/server')
  return {
    ...actual,
    agentHookServer: {
      dropStatusEntry,
      getStatusSnapshot
    }
  }
})

vi.mock('../claude/hook-service', () => ({
  claudeHookService: { getStatus: vi.fn(() => ({ agent: 'claude', state: 'absent' })) }
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { getStatus: vi.fn(() => ({ agent: 'codex', state: 'absent' })) }
}))
vi.mock('../gemini/hook-service', () => ({
  geminiHookService: { getStatus: vi.fn(() => ({ agent: 'gemini', state: 'absent' })) }
}))
vi.mock('../cursor/hook-service', () => ({
  cursorHookService: { getStatus: vi.fn(() => ({ agent: 'cursor', state: 'absent' })) }
}))

beforeEach(() => {
  dropStatusEntry.mockReset()
  getStatusSnapshot.mockReset()
  onHandlers.clear()
  handleHandlers.clear()
  removeHandler.mockReset()
  removeAllListeners.mockReset()
})

afterEach(() => {
  vi.resetModules()
})

describe('agentStatus:getSnapshot IPC', () => {
  it('returns the hook cache snapshot', async () => {
    const snapshot = [
      {
        paneKey: 'tab-1:0',
        state: 'done',
        prompt: 'p',
        agentType: 'claude',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ]
    getStatusSnapshot.mockReturnValue(snapshot)
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentStatus:getSnapshot')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual(snapshot)
  })
})

describe('agentStatus:drop IPC', () => {
  it('forwards drop to dropStatusEntry', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = onHandlers.get('agentStatus:drop')
    expect(handler).toBeDefined()
    handler!({}, 'tab-1:0')
    expect(dropStatusEntry).toHaveBeenCalledWith('tab-1:0')
  })

  it('rejects non-string paneKey (defensive against a malformed renderer message)', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = onHandlers.get('agentStatus:drop')!
    const bad: unknown[] = [
      123,
      undefined,
      '',
      null,
      {},
      [],
      'no-colon', // missing colon — rejected by isValidPaneKey
      ':leading', // empty tabId half
      'trailing:', // empty paneId half
      'a:b:c' // multiple colons
    ]
    for (const value of bad) {
      expect(() => handler({}, value)).not.toThrow()
    }
    expect(dropStatusEntry).not.toHaveBeenCalled()
  })
})
