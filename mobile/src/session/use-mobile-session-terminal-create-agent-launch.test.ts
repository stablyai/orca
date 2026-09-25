import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { launchedSelection, type PendingSessionSelection } from './pending-session-selection'
import { AGENT_PROMPT_NOT_SENT_MESSAGE } from './pr-ai-triage-launch'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'

vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn(), triggerError: vi.fn() }))

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]
const RECEIPT = { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' }

function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function launchReply(outcome: object, prompt?: object): RpcResponse {
  return ok({ outcome, worktreeId: 'workspace-1', receipt: RECEIPT, ...(prompt ? { prompt } : {}) })
}

// A connected client whose only behaviour is the scripted `sendRequest`.
function requestPortRpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function scriptedClient(...replies: RpcResponse[]) {
  let call = 0
  const sendRequest = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => {
    const reply = replies[Math.min(call, replies.length - 1)]!
    call += 1
    return reply
  })
  return { client: requestPortRpcClient(sendRequest), sendRequest }
}

function mutableRef<T>(current: T): { current: T } {
  return { current }
}

function scope(client: RpcClient, hostCapabilities: string[] = LAUNCH_CAPABILITIES) {
  return {
    worktreeId: 'workspace-1',
    client,
    hostCapabilities,
    connState: 'connected',
    setTerminals: vi.fn(),
    terminalsRef: { current: [] },
    setSessionTabs: vi.fn(),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    activeSessionTabId: 'existing-tab',
    setActiveSessionTabId: vi.fn(),
    setCreating: vi.fn(),
    creatingTerminalRef: { current: false },
    creatingBrowser: false,
    creatingMarkdown: false,
    setCreateError: vi.fn(),
    deviceTokenRef: { current: null },
    initializedHandlesRef: { current: new Set<string>() },
    activeHandleRef: mutableRef<string | null>('existing-terminal'),
    activeSessionTabTypeRef: { current: 'terminal' },
    pendingSelectionRef: mutableRef<PendingSessionSelection | null>(null),
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    fetchSessionTabs: vi.fn(async () => {})
  }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

async function create_(
  state: ReturnType<typeof scope>,
  ...args: Parameters<
    ReturnType<typeof useMobileSessionTerminalCreateActions>['handleCreateTerminal']
  >
) {
  let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member handleCreateTerminal reads; a missing one throws on use.
    actions = useMobileSessionTerminalCreateActions(state as never)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await act(async () => {
    await actions?.handleCreateTerminal(...args)
  })
}

function methods(sendRequest: ReturnType<typeof scriptedClient>['sendRequest']): string[] {
  return sendRequest.mock.calls.map(([method]) => method)
}

function launchParams(sendRequest: ReturnType<typeof scriptedClient>['sendRequest']): unknown {
  return sendRequest.mock.calls.find(([method]) => method === 'agent.launchReplay')?.[1]
}

describe('the + menu', () => {
  it('asks the host to start the agent and waits for its terminal by handle', async () => {
    const { client, sendRequest } = scriptedClient(
      launchReply({ kind: 'terminal', handle: 'term_7' })
    )
    const state = scope(client)

    await create_(state, 'claude')

    expect(methods(sendRequest)).toEqual(['agent.launchReplay'])
    expect(launchParams(sendRequest)).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:workspace-1' }
    })
    expect(launchParams(sendRequest)).not.toHaveProperty('prompt')
    expect(launchParams(sendRequest)).not.toHaveProperty('launchSource')
    expect(state.pendingSelectionRef.current).toEqual(launchedSelection({ handle: 'term_7' }))
    expect(state.scheduleDelayedAction).toHaveBeenCalledWith(expect.any(Function), 500)
  })

  it('waits for a chat by its session id, not a predicted tab id', async () => {
    const { client } = scriptedClient(
      launchReply({ kind: 'structured', sessionId: 'claude_s1', handle: 'h' })
    )
    const state = scope(client)

    await create_(state, 'claude')

    expect(state.pendingSelectionRef.current).toEqual(launchedSelection({ sessionId: 'claude_s1' }))
    expect(state.setActiveSessionTabId).not.toHaveBeenCalled()
  })

  it("keeps today's path on a host without the launch capabilities", async () => {
    const { client, sendRequest } = scriptedClient(
      ok({ tab: { type: 'terminal', id: 'tab-9', terminal: 'term_9', isActive: true } })
    )

    await create_(scope(client, []), 'aider')

    expect(methods(sendRequest)).toEqual(['session.tabs.createTerminal'])
  })

  it("keeps today's path when the host refuses the first send as unsupported", async () => {
    const { client, sendRequest } = scriptedClient(
      {
        id: 'x',
        ok: false,
        error: { code: 'agent_launch_replay_unsupported', message: 'no' },
        _meta: { runtimeId: 'r' }
      },
      ok({ tab: { type: 'terminal', id: 'tab-9', terminal: 'term_9', isActive: true } })
    )

    await create_(scope(client), 'aider')

    expect(methods(sendRequest)).toEqual(['agent.launchReplay', 'session.tabs.createTerminal'])
  })

  it('never starts a second agent when the outcome is unknown', async () => {
    const { client, sendRequest } = scriptedClient({
      id: 'x',
      ok: false,
      error: {
        code: 'agent_session_operation_unknown',
        message: 'agent_session_operation_unknown'
      },
      _meta: { runtimeId: 'r' }
    })
    const state = scope(client)

    await create_(state, 'claude')

    expect(methods(sendRequest)).toEqual(['agent.launchReplay'])
    expect(state.showToast).toHaveBeenCalledWith(
      "Couldn't confirm the agent started. Check the workspace before trying again.",
      1800
    )
  })
})

describe('launches that carry a prompt', () => {
  it('sends an agent quick command as the first prompt', async () => {
    const { client, sendRequest } = scriptedClient(
      launchReply(
        { kind: 'terminal', handle: 'term_7' },
        { delivery: 'submit', outcome: 'handed-to-terminal' }
      )
    )

    await create_(scope(client), 'claude', { agentPrompt: 'run the tests' })

    expect(launchParams(sendRequest)).toMatchObject({
      prompt: { text: 'run the tests', delivery: 'submit' },
      launchSource: 'quick_command'
    })
  })

  it('marks review notes sent only when the host delivered them', async () => {
    const { client, sendRequest } = scriptedClient(
      launchReply(
        { kind: 'terminal', handle: 'term_7' },
        { delivery: 'submit', outcome: 'handed-to-terminal' }
      )
    )
    const state = scope(client)
    const onPromptSent = vi.fn()

    await create_(state, 'codex', { initialPrompt: 'the notes', onPromptSent })

    expect(launchParams(sendRequest)).toMatchObject({ launchSource: 'diff_notes_send' })
    expect(methods(sendRequest)).not.toContain('terminal.send')
    expect(onPromptSent).toHaveBeenCalledOnce()
    expect(state.showToast).toHaveBeenCalledWith('Notes sent')
  })

  it('keeps review notes unsent when the agent started without them', async () => {
    const { client } = scriptedClient(
      launchReply(
        { kind: 'terminal', handle: 'term_7' },
        { delivery: 'submit', outcome: 'not-delivered' }
      )
    )
    const state = scope(client)
    const onPromptSent = vi.fn()

    await create_(state, 'codex', { initialPrompt: 'the notes', onPromptSent })

    expect(onPromptSent).not.toHaveBeenCalled()
    expect(state.showToast).toHaveBeenCalledWith(
      "The agent started, but the notes weren't sent.",
      2400
    )
  })

  it('says a quick command prompt was not sent', async () => {
    const { client } = scriptedClient(
      launchReply(
        { kind: 'terminal', handle: 'term_7' },
        { delivery: 'submit', outcome: 'not-delivered' }
      )
    )
    const state = scope(client)

    await create_(state, 'claude', { agentPrompt: 'run the tests' })

    expect(state.showToast).toHaveBeenCalledWith(AGENT_PROMPT_NOT_SENT_MESSAGE, 2400)
  })

  it('leaves shell-command quick commands on a plain terminal', async () => {
    const { client, sendRequest } = scriptedClient(
      ok({ tab: { type: 'terminal', id: 'tab-9', terminal: 'term_9', isActive: true } })
    )

    await create_(scope(client), undefined, {
      startupCommand: 'npm test',
      startupCommandDelivery: 'shell-ready'
    })

    expect(methods(sendRequest)).toEqual(['session.tabs.createTerminal'])
  })
})
