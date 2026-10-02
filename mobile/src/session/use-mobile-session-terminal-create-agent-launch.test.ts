import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchOutcome,
  AgentLaunchPromptReceipt
} from '../../../src/shared/agent-launch-intent'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import {
  AGENT_LAUNCH_RESERVATION_TAKEN_MESSAGE,
  AGENT_LAUNCH_UNCONFIRMED_MESSAGE
} from './mobile-existing-agent-launch'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  LAUNCHED_SELECTION_SNAPSHOT_BUDGET,
  resolveLaunchedSelection,
  type PendingSessionSelection
} from './pending-session-selection'
import { NOTES_UNCONFIRMED_MESSAGE, PROMPT_UNCONFIRMED_MESSAGE } from './new-tab-agent-host-launch'
import { AGENT_PROMPT_NOT_SENT_MESSAGE } from './pr-ai-triage-launch'
import { releaseTerminalCreateLock } from './terminal-create-lock'
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

function launchReply(outcome: AgentLaunchOutcome, prompt?: AgentLaunchPromptReceipt): RpcResponse {
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
    sessionTabsRef: mutableRef<MobileSessionTab[]>([]),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    activeSessionTabId: 'existing-tab',
    activeSessionTabIdRef: mutableRef<string | null>('existing-tab'),
    setActiveSessionTabId: vi.fn(),
    setCreating: vi.fn(),
    creatingTerminalRef: mutableRef<string | null>(null),
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

function refusal(code: string): RpcResponse {
  return { id: 'x', ok: false, error: { code, message: code }, _meta: { runtimeId: 'r' } }
}

/** The reservation a launch sent: its pane halves and session id. */
function sentReservation(params: unknown): { tabId: string; leafId: string; sessionId?: string } {
  const sent = params !== null && typeof params === 'object' ? params : {}
  const pane =
    'paneKey' in sent && typeof sent.paneKey === 'string' ? parsePaneKey(sent.paneKey) : null
  if (!pane) {
    throw new Error('launch sent no pane key')
  }
  const sessionId =
    'sessionId' in sent && typeof sent.sessionId === 'string' ? sent.sessionId : undefined
  return { tabId: pane.tabId, leafId: pane.leafId, ...(sessionId ? { sessionId } : {}) }
}

/** The terminal tab the host lists for a reserved pane. */
function reservedTab(params: unknown, terminal: string): MobileSessionTab {
  const { tabId, leafId } = sentReservation(params)
  return {
    type: 'terminal',
    id: `${tabId}::${leafId}`,
    parentTabId: tabId,
    leafId,
    title: 'Aider',
    terminal,
    isActive: false
  }
}

function awaitingReply(surface: Record<string, unknown>): unknown {
  return expect.objectContaining({
    kind: 'launched',
    surface: expect.objectContaining(surface),
    snapshotsLeft: LAUNCHED_SELECTION_SNAPSHOT_BUDGET
  })
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
    expect(state.pendingSelectionRef.current).toEqual(awaitingReply({ handle: 'term_7' }))
    // Read at once: the host published the tab before replying.
    expect(state.fetchSessionTabs).toHaveBeenCalledTimes(1)
    expect(state.scheduleDelayedAction).not.toHaveBeenCalled()
  })

  it('waits for a chat by its session id, not a predicted tab id', async () => {
    const { client } = scriptedClient(
      launchReply({ kind: 'structured', sessionId: 'claude_s1', handle: 'h' })
    )
    const state = scope(client)

    await create_(state, 'claude')

    expect(state.pendingSelectionRef.current).toEqual(awaitingReply({ sessionId: 'claude_s1' }))
    expect(state.setActiveSessionTabId).not.toHaveBeenCalled()
  })

  it('names the pane and chat it will create, and resends the same ids on a replay', async () => {
    const reply = launchReply({ kind: 'terminal', handle: 'term_7' })
    const sendRequest = vi.fn(
      async (_method: string, _params?: unknown, _options?: unknown) => reply
    )
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    const state = scope(requestPortRpcClient(sendRequest))

    await create_(state, 'claude')

    const sends = sendRequest.mock.calls.filter(([method]) => method === 'agent.launchReplay')
    expect(sends).toHaveLength(2)
    expect(sends[1]![1]).toEqual(sends[0]![1])
    const reserved = sentReservation(sends[0]![1])
    expect(reserved.tabId).not.toContain(':')
    expect(reserved.sessionId).toMatch(/^claude_[A-Za-z0-9_]+$/)
    expect(state.pendingSelectionRef.current).toEqual(
      awaitingReply({
        pane: { tabId: reserved.tabId, leafId: reserved.leafId },
        sessionId: reserved.sessionId,
        handle: 'term_7'
      })
    )
  })

  it('reserves a new pane for every tap', async () => {
    const { client, sendRequest } = scriptedClient(
      launchReply({ kind: 'terminal', handle: 'term_7' })
    )
    const state = scope(client)

    await create_(state, 'aider')
    await create_(state, 'aider')

    const [first, second] = sendRequest.mock.calls.map(([, params]) => params)
    expect(sentReservation(first).tabId).not.toBe(sentReservation(second).tabId)
    // Only an agent the host may start as a chat names a session.
    expect(first).not.toHaveProperty('sessionId')
  })

  it("lands by the reply's ids when an older host ignored the reservation", async () => {
    const { client } = scriptedClient(launchReply({ kind: 'terminal', handle: 'term_host' }))
    const state = scope(client)

    await create_(state, 'aider')

    const hostMinted: MobileSessionTab = {
      type: 'terminal',
      id: 'host-tab::host-leaf',
      parentTabId: 'host-tab',
      leafId: 'host-leaf',
      title: 'Aider',
      terminal: 'term_host',
      isActive: false
    }
    expect(resolveLaunchedSelection(state.pendingSelectionRef.current, [hostMinted])).toEqual({
      selection: { kind: 'terminal', handle: 'term_host', tabId: 'host-tab::host-leaf' },
      landedTabId: 'host-tab::host-leaf'
    })
  })

  it.each(['agent_launch_pane_already_live', 'agent_launch_session_already_exists'])(
    'says plainly that nothing started when the host refuses the reservation (%s)',
    async (code) => {
      const { client } = scriptedClient(refusal(code))
      const state = scope(client)

      await create_(state, 'claude')

      expect(state.showToast).toHaveBeenCalledWith(AGENT_LAUNCH_RESERVATION_TAKEN_MESSAGE, 1800)
      expect(state.pendingSelectionRef.current).toBeNull()
      expect(state.creatingTerminalRef.current).toBeNull()
    }
  )

  it('never calls a taken reservation a clean failure after a replay: it may be this launch', async () => {
    const sendRequest = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) =>
      refusal('agent_launch_pane_already_live')
    )
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    const state = scope(requestPortRpcClient(sendRequest))

    await create_(state, 'claude')

    expect(state.showToast).toHaveBeenCalledWith(AGENT_LAUNCH_UNCONFIRMED_MESSAGE, 1800)
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

  it("shows the host's refusal even when the session already has tabs", async () => {
    const { client, sendRequest } = scriptedClient({
      id: 'x',
      ok: false,
      error: {
        code: 'agent_launch_failed',
        message: 'Agent claude is disabled. Choose an enabled agent.'
      },
      _meta: { runtimeId: 'r' }
    })
    const state = scope(client)

    await create_(state, 'claude')

    expect(methods(sendRequest)).toEqual(['agent.launchReplay'])
    expect(state.showToast).toHaveBeenCalledWith(
      'Agent claude is disabled. Choose an enabled agent.',
      1800
    )
    expect(state.pendingSelectionRef.current).toBeNull()
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

  it('lands on the tab and frees the + lock before a paste-after-start agent replies', async () => {
    const reply = launchReply(
      { kind: 'terminal', handle: 'term_7' },
      { delivery: 'submit', outcome: 'handed-to-terminal' }
    )
    const state = scope(scriptedClient(reply).client)
    let landedBeforeReply: PendingSessionSelection | null = null
    state.client = requestPortRpcClient(async (_method, params) => {
      // The host lists the tab as soon as it exists, then waits for the agent to paste into it.
      const pending = state.pendingSelectionRef.current
      const landed = resolveLaunchedSelection(pending, [reservedTab(params, 'term_7')])
      state.pendingSelectionRef.current = landed.selection
      if (landed.landedTabId && pending?.kind === 'launched') {
        releaseTerminalCreateLock(state, pending.lock)
      }
      landedBeforeReply = state.pendingSelectionRef.current
      expect(state.creatingTerminalRef.current).toBeNull()
      return reply
    })

    await create_(state, 'aider', { agentPrompt: 'run the tests' })

    expect(landedBeforeReply).toEqual(
      expect.objectContaining({ kind: 'terminal', handle: 'term_7' })
    )
    // The late reply leaves the landed pick alone.
    expect(state.pendingSelectionRef.current).toBe(landedBeforeReply)
    expect(state.setCreating).toHaveBeenCalledTimes(2)
  })

  it("keeps a second launch's + lock when the first one's reply comes in", async () => {
    const reply = launchReply(
      { kind: 'terminal', handle: 'term_7' },
      { delivery: 'submit', outcome: 'handed-to-terminal' }
    )
    const state = scope(scriptedClient(reply).client)
    state.client = requestPortRpcClient(async () => {
      // The first tab landed and freed the lock; the user started another launch.
      state.creatingTerminalRef.current = 'mobile-create:second'
      return reply
    })

    await create_(state, 'aider', { agentPrompt: 'run the tests' })

    expect(state.creatingTerminalRef.current).toBe('mobile-create:second')
    expect(state.setCreating).not.toHaveBeenCalledWith(false)
  })

  it('leaves the user on a tab they picked while the prompt was being delivered', async () => {
    const reply = launchReply(
      { kind: 'terminal', handle: 'term_7' },
      { delivery: 'submit', outcome: 'handed-to-terminal' }
    )
    const userPick: PendingSessionSelection = { kind: 'tab', tabId: 'other-tab' }
    const state = scope(scriptedClient(reply).client)
    state.client = requestPortRpcClient(async () => {
      // The user taps another tab before the host replies.
      state.activeSessionTabIdRef.current = 'other-tab'
      state.pendingSelectionRef.current = userPick
      return reply
    })

    await create_(state, 'claude', { agentPrompt: 'run the tests' })

    expect(state.pendingSelectionRef.current).toBe(userPick)
    expect(state.fetchSessionTabs).toHaveBeenCalledOnce()
  })

  it.each([
    [{ initialPrompt: 'the notes' }, NOTES_UNCONFIRMED_MESSAGE],
    [{ agentPrompt: 'run the tests' }, PROMPT_UNCONFIRMED_MESSAGE]
  ])(
    'says only the prompt is in doubt when the reply is lost after the tab landed (%o)',
    async (options, message) => {
      const state = scope(scriptedClient().client)
      const onPromptSent = vi.fn()
      state.client = requestPortRpcClient(async (_method, params) => {
        // The tab is listed, then the answer never arrives.
        state.sessionTabsRef.current = [reservedTab(params, 'term_7')]
        throw markRpcDeliveryUnknown(new Error('response lost'))
      })

      await create_(state, 'aider', { ...options, onPromptSent })

      expect(state.showToast).toHaveBeenCalledExactlyOnceWith(message, 2400)
      expect(state.setCreateError).not.toHaveBeenCalledWith(AGENT_LAUNCH_UNCONFIRMED_MESSAGE)
      expect(onPromptSent).not.toHaveBeenCalled()
    }
  )

  it('says nothing when a bare launch lost its reply after its tab landed', async () => {
    const state = scope(scriptedClient().client)
    state.client = requestPortRpcClient(async (_method, params) => {
      state.sessionTabsRef.current = [reservedTab(params, 'term_7')]
      throw markRpcDeliveryUnknown(new Error('response lost'))
    })

    await create_(state, 'aider')

    expect(state.showToast).not.toHaveBeenCalled()
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
