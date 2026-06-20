import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AgentHookServerModule from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'

// Why: cover the agentStatus:drop IPC handler — it must propagate the
// renderer dismissal to dropStatusEntry so the on-disk last-status file
// evicts the entry.

const dropStatusEntry = vi.fn()
const getStatusSnapshot = vi.fn()
const inferInterrupt = vi.fn()
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const removeHandler = vi.fn()
const removeAllListeners = vi.fn()
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_PANE_KEY = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

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
      getStatusSnapshot,
      inferInterrupt
    }
  }
})

vi.mock('../claude/hook-service', () => ({
  claudeHookService: { getStatus: vi.fn(() => ({ agent: 'claude', state: 'absent' })) }
}))
vi.mock('../openclaude/hook-service', () => ({
  openClaudeHookService: { getStatus: vi.fn(() => ({ agent: 'openclaude', state: 'absent' })) }
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { getStatus: vi.fn(() => ({ agent: 'codex', state: 'absent' })) }
}))
vi.mock('../gemini/hook-service', () => ({
  geminiHookService: { getStatus: vi.fn(() => ({ agent: 'gemini', state: 'absent' })) }
}))
vi.mock('../antigravity/hook-service', () => ({
  antigravityHookService: { getStatus: vi.fn(() => ({ agent: 'antigravity', state: 'absent' })) }
}))
vi.mock('../amp/hook-service', () => ({
  ampHookService: { getStatus: vi.fn(() => ({ agent: 'amp', state: 'absent' })) }
}))
vi.mock('../cursor/hook-service', () => ({
  cursorHookService: { getStatus: vi.fn(() => ({ agent: 'cursor', state: 'absent' })) }
}))
vi.mock('../droid/hook-service', () => ({
  droidHookService: { getStatus: vi.fn(() => ({ agent: 'droid', state: 'absent' })) }
}))
vi.mock('../command-code/hook-service', () => ({
  commandCodeHookService: { getStatus: vi.fn(() => ({ agent: 'command-code', state: 'absent' })) }
}))
vi.mock('../grok/hook-service', () => ({
  grokHookService: { getStatus: vi.fn(() => ({ agent: 'grok', state: 'absent' })) }
}))
vi.mock('../copilot/hook-service', () => ({
  copilotHookService: { getStatus: vi.fn(() => ({ agent: 'copilot', state: 'absent' })) }
}))
vi.mock('../hermes/hook-service', () => ({
  hermesHookService: { getStatus: vi.fn(() => ({ agent: 'hermes', state: 'absent' })) }
}))
vi.mock('../devin/hook-service', () => ({
  devinHookService: { getStatus: vi.fn(() => ({ agent: 'devin', state: 'absent' })) }
}))
vi.mock('../kimi/hook-service', () => ({
  kimiHookService: { getStatus: vi.fn(() => ({ agent: 'kimi', state: 'absent' })) }
}))

beforeEach(() => {
  dropStatusEntry.mockReset()
  getStatusSnapshot.mockReset()
  inferInterrupt.mockReset()
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
        paneKey: PANE_KEY,
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

  it('enriches the hook cache snapshot with runtime lineage metadata', async () => {
    const snapshot = [
      {
        paneKey: PANE_KEY,
        state: 'done',
        prompt: 'parent',
        agentType: 'codex',
        connectionId: null,
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      },
      {
        paneKey: CHILD_PANE_KEY,
        state: 'done',
        prompt: 'child',
        agentType: 'codex',
        connectionId: null,
        receivedAt: 1_700_000_001_000,
        stateStartedAt: 1_700_000_000_500
      }
    ]
    getStatusSnapshot.mockReturnValue(snapshot)
    const runtime = {
      getAgentStatusTerminalHandleForPaneKey: vi.fn((paneKey: string) =>
        paneKey === PANE_KEY ? 'term-parent' : paneKey === CHILD_PANE_KEY ? 'term-child' : undefined
      ),
      getAgentStatusOrchestrationContextForPaneKey: vi.fn((paneKey: string) =>
        paneKey === CHILD_PANE_KEY
          ? {
              taskId: 'task-child',
              dispatchId: 'dispatch-child',
              parentTerminalHandle: 'term-parent',
              parentPaneKey: PANE_KEY,
              coordinatorHandle: 'term-parent'
            }
          : undefined
      )
    }
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers(runtime)

    const handler = handleHandlers.get('agentStatus:getSnapshot')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual([
      {
        ...snapshot[0],
        terminalHandle: 'term-parent'
      },
      {
        ...snapshot[1],
        terminalHandle: 'term-child',
        orchestration: {
          taskId: 'task-child',
          dispatchId: 'dispatch-child',
          parentTerminalHandle: 'term-parent',
          parentPaneKey: PANE_KEY,
          coordinatorHandle: 'term-parent'
        }
      }
    ])
  })
})

describe('agentHooks:antigravityStatus IPC', () => {
  it('returns Antigravity hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:antigravityStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'antigravity', state: 'absent' })
  })
})

describe('agentHooks:ampStatus IPC', () => {
  it('returns Amp hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:ampStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'amp', state: 'absent' })
  })
})

describe('agentHooks:openClaudeStatus IPC', () => {
  it('returns OpenClaude hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:openClaudeStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'openclaude', state: 'absent' })
  })
})

describe('agentHooks:commandCodeStatus IPC', () => {
  it('returns Command Code hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:commandCodeStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'command-code', state: 'absent' })
  })
})

describe('agentHooks:devinStatus IPC', () => {
  it('returns Devin hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:devinStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'devin', state: 'absent' })
  })
})

describe('agentHooks:kimiStatus IPC', () => {
  it('returns Kimi hook installation status', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentHooks:kimiStatus')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual({ agent: 'kimi', state: 'absent' })
  })
})

describe('agentStatus:inferInterrupt IPC', () => {
  it('forwards valid inference requests to the hook server', async () => {
    inferInterrupt.mockReturnValue(true)
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentStatus:inferInterrupt')
    expect(handler).toBeDefined()
    const request = {
      paneKey: PANE_KEY,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'long task',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    }

    expect(handler!({}, request)).toBe(true)
    expect(inferInterrupt).toHaveBeenCalledWith(request)
  })

  it('rejects malformed requests before the hook server boundary', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = handleHandlers.get('agentStatus:inferInterrupt')
    expect(handler).toBeDefined()
    for (const value of [null, undefined, '', 123, true]) {
      expect(handler!({}, value)).toBe(false)
    }
    expect(inferInterrupt).not.toHaveBeenCalled()
  })
})

describe('agentStatus:drop IPC', () => {
  it('forwards drop to dropStatusEntry', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    registerAgentHookHandlers()

    const handler = onHandlers.get('agentStatus:drop')
    expect(handler).toBeDefined()
    handler!({}, PANE_KEY)
    expect(dropStatusEntry).toHaveBeenCalledWith(PANE_KEY)
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
      'tab-1:0', // legacy numeric pane-key suffix
      'no-colon', // missing colon — rejected by isValidPaneKey
      ':leading', // empty tabId half
      'trailing:', // empty leafId half
      'a:b:c' // multiple colons
    ]
    for (const value of bad) {
      expect(() => handler({}, value)).not.toThrow()
    }
    expect(dropStatusEntry).not.toHaveBeenCalled()
  })
})
