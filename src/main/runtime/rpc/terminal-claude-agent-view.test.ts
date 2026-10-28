import './unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_CLAUDE_AGENT_VIEW_METHODS } from './methods/terminal/terminal-claude-agent-view-method'

const identity = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  sessionId: 'session',
  instanceId: 'mod'
}
const now = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ now })
})

afterEach(() => {
  agentHookServer.claudeAgentViews.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['permission', 'new-session', 'new-mod', 'new-pty', 'mobile-lock'] as const)(
  'refuses the shortcut when %s arrives before the terminal write',
  async (change) => {
    let sessionId = identity.sessionId
    let permission = false
    let ptyId = 'pty'
    let mobileLocked = false
    vi.spyOn(agentHookServer, 'getStatusSnapshotForPane').mockImplementation(() => [
      {
        paneKey: identity.paneKey,
        agentType: 'claude',
        state: 'done',
        prompt: '',
        providerSession: { key: 'session_id', id: sessionId },
        connectionId: null,
        receivedAt: now,
        stateStartedAt: now
      }
    ])
    agentHookServer.claudeAgentViews.receive({
      ...identity,
      action: 'register',
      view: { revision: 1 },
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const write = vi.fn()
    const overrides: Partial<OrcaRuntimeService> = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn(() => ({ ptyId })),
      getLiveTerminalPaneKey: () => identity.paneKey,
      getDriver: vi.fn<OrcaRuntimeService['getDriver']>(() =>
        mobileLocked ? { kind: 'mobile', clientId: 'phone' } : { kind: 'desktop' }
      ),
      getTerminalAgentStatus: vi.fn<OrcaRuntimeService['getTerminalAgentStatus']>(async () => ({
        handle: 'terminal',
        isRunningAgent: true,
        status: permission ? 'permission' : 'idle'
      })),
      sendTerminal: vi.fn(async (_handle, _action, options) => {
        if (change === 'permission') {
          permission = true
        }
        if (change === 'new-session') {
          sessionId = 'replacement'
        }
        if (change === 'new-pty') {
          ptyId = 'replacement'
        }
        if (change === 'mobile-lock') {
          mobileLocked = true
        }
        if (change === 'new-mod') {
          agentHookServer.claudeAgentViews.receive({
            ...identity,
            instanceId: 'replacement',
            action: 'register',
            view: { revision: 1 },
            keybindings: JSON.stringify({
              bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+h': 'command:orca-agent-view' } }]
            })
          })
        }
        await options?.beforeWrite?.('pty')
        write()
        return { handle: 'terminal', accepted: true, bytesWritten: 8 }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this scoped dispatcher reaches only the runtime methods defined above.
    const runtime = overrides as OrcaRuntimeService
    const response = await new RpcDispatcher({
      runtime,
      methods: TERMINAL_CLAUDE_AGENT_VIEW_METHODS
    }).dispatch({
      id: 'request',
      authToken: 'token',
      method: 'terminal.viewClaudeAgent',
      params: {
        terminal: 'terminal',
        sessionId: identity.sessionId,
        agentId: 'child',
        client: { id: 'desktop', type: 'desktop' }
      }
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        view: { status: change === 'permission' ? 'permission' : 'unavailable' }
      }
    })
    expect(write).not.toHaveBeenCalled()
  }
)
