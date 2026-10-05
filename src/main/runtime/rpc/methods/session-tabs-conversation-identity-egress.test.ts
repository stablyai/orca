// A terminal tab's conversation field and offer reach every audience but a phone without the
// identity capability, which gets them folded into agentStatus instead. Every tab-bearing egress
// is driven through the real dispatcher and JSON.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import type { TerminalConversationIdentity } from '../../../../shared/terminal-conversation-identity'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { TERMINAL_ORPHAN_METHODS } from './terminal-orphan'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type ClientKind = 'mobile' | 'runtime' | undefined
/** A phone that reads the field itself. */
type Audience = ClientKind | 'capable-mobile'

const identity: TerminalConversationIdentity = {
  agentType: 'codex',
  providerSession: { key: 'session_id', id: 'codex-session', transcriptPath: '/r.jsonl' },
  capturedAt: 1234,
  source: 'live'
}
// The exact shape #25358's private carrier had, so shipped phones see no change.
const fold: AgentStatusEntry = {
  state: 'done',
  sessionBoundary: true,
  prompt: '',
  updatedAt: 1234,
  stateStartedAt: 1234,
  stateHistory: [],
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  terminalTitle: 'Say hi | my-repo',
  agentType: 'codex',
  providerSession: identity.providerSession,
  terminalHandle: 'term-1',
  worktreeId: 'wt-1'
}
const statuslessTab: RuntimeMobileSessionTerminalClientTab = {
  type: 'terminal',
  id: 'tab-1::leaf-1',
  parentTabId: 'tab-1',
  leafId: 'leaf-1',
  title: 'Say hi | my-repo',
  isActive: true,
  launchAgent: 'codex',
  status: 'ready',
  terminal: 'term-1'
}
const offeredTab: RuntimeMobileSessionTerminalClientTab = {
  ...statuslessTab,
  conversationIdentity: identity,
  conversationOfferedWithoutStatus: true
}

function snapshotOf(
  tab: RuntimeMobileSessionTerminalClientTab,
  snapshotVersion = 1
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'headless:1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    tabs: [tab]
  }
}

function harness(): {
  dispatcher: RpcDispatcher
  publish: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
  runtime: OrcaRuntimeService
} {
  const runtime = new OrcaRuntimeService()
  const listeners: ((snapshot: RuntimeMobileSessionTabsResult, sequence: number) => void)[] = []
  vi.spyOn(runtime, 'listMobileSessionTabs').mockResolvedValue(snapshotOf(offeredTab))
  vi.spyOn(runtime, 'listAllMobileSessionTabs').mockResolvedValue([snapshotOf(offeredTab)])
  vi.spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence').mockResolvedValue({
    snapshots: [snapshotOf(offeredTab)],
    changeSequence: 0
  })
  vi.spyOn(runtime, 'supportsAuthoritativeSessionTabsInventory').mockReturnValue(false)
  vi.spyOn(runtime, 'activateMobileSessionTab').mockResolvedValue(snapshotOf(offeredTab))
  vi.spyOn(runtime, 'createMobileSessionTerminal').mockResolvedValue({
    tab: offeredTab,
    publicationEpoch: 'headless:1',
    snapshotVersion: 1
  })
  vi.spyOn(runtime, 'adoptTerminalOrphans').mockResolvedValue({
    adopted: false,
    topologyRevision: 1,
    snapshot: snapshotOf(offeredTab)
  })
  vi.spyOn(runtime, 'onMobileSessionTabsChanged').mockImplementation((listener) => {
    listeners.push(listener)
    return () => {}
  })
  return {
    runtime,
    dispatcher: new RpcDispatcher({
      runtime,
      methods: [...SESSION_TAB_METHODS, ...TERMINAL_ORPHAN_METHODS]
    }),
    publish: (snapshot, changeSequence) => {
      for (const listener of listeners) {
        listener(snapshot, changeSequence)
      }
    }
  }
}

async function dispatch(
  dispatcher: RpcDispatcher,
  method: string,
  params: unknown,
  audience: Audience
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: method, authToken: 'tok', method, params },
    (raw) => replies.push(JSON.parse(raw)),
    audience === 'capable-mobile'
      ? {
          clientKind: 'mobile',
          connectionId: 'conn-capable-mobile',
          clientCapabilities: [TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY]
        }
      : { clientKind: audience, connectionId: `conn-${String(audience)}` }
  )
  expect(replies[0]?.ok).toBe(true)
  return replies
}

function resultOf(reply: RpcResponse | undefined): unknown {
  return reply?.ok ? reply.result : undefined
}

/** The terminal tab exactly as the audience should receive it; an old phone reads only the fold. */
function expectedTab(audience: Audience): unknown {
  return JSON.parse(
    JSON.stringify(audience === 'mobile' ? { ...statuslessTab, agentStatus: fold } : offeredTab)
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('conversation identity egress', () => {
  it.each<Audience>(['mobile', 'capable-mobile', 'runtime', undefined])(
    'publishes the field on every session.tabs route and folds it only for an old phone (%s)',
    async (clientKind) => {
      const { dispatcher, publish } = harness()
      const tab = expectedTab(clientKind)
      const worktree = { worktree: 'id:wt-1' }

      expect(
        resultOf((await dispatch(dispatcher, 'session.tabs.list', worktree, clientKind))[0])
      ).toMatchObject({
        tabs: [tab]
      })
      const subscribed = await dispatch(dispatcher, 'session.tabs.subscribe', worktree, clientKind)
      publish(snapshotOf(offeredTab, 2), 1)
      expect(subscribed.map(resultOf)).toEqual([
        expect.objectContaining({ tabs: [tab] }),
        expect.objectContaining({ tabs: [tab] })
      ])
      expect(
        resultOf((await dispatch(dispatcher, 'session.tabs.listAll', undefined, clientKind))[0])
      ).toMatchObject({ snapshots: [{ tabs: [tab] }] })
      const all = await dispatch(dispatcher, 'session.tabs.subscribeAll', undefined, clientKind)
      publish(snapshotOf(offeredTab, 3), 2)
      expect(all.map(resultOf)).toEqual([
        expect.objectContaining({ snapshots: [expect.objectContaining({ tabs: [tab] })] }),
        expect.objectContaining({ tabs: [tab] })
      ])
      expect(
        resultOf(
          (
            await dispatch(
              dispatcher,
              'session.tabs.activate',
              { ...worktree, tabId: statuslessTab.id },
              clientKind
            )
          )[0]
        )
      ).toMatchObject({ tabs: [tab] })
    }
  )

  it.each<Audience>(['mobile', 'capable-mobile', 'runtime', undefined])(
    'sends the unfolded create and adopt results with the field and never a fold (%s)',
    async (clientKind) => {
      const { dispatcher } = harness()
      const statusless = JSON.parse(JSON.stringify(offeredTab))

      const created = resultOf(
        (
          await dispatch(
            dispatcher,
            'session.tabs.createTerminal',
            { worktree: 'id:wt-1' },
            clientKind
          )
        )[0]
      )
      expect(created).toMatchObject({ tab: statusless })
      expect(created).not.toHaveProperty('tab.agentStatus')

      const adopted = resultOf(
        (
          await dispatch(
            dispatcher,
            'terminal.adoptOrphans',
            {
              worktree: 'id:wt-1',
              expectedTopologyRevision: 1,
              claims: [
                {
                  terminal: 'term-1',
                  ptyId: 'pty-1',
                  incarnationId: 'inc-1',
                  tabId: 'tab-1',
                  leafId: 'leaf-1'
                }
              ]
            },
            clientKind
          )
        )[0]
      )
      expect(adopted).toMatchObject({ snapshot: { tabs: [statusless] } })
      expect(adopted).not.toHaveProperty('snapshot.tabs.0.agentStatus')
    }
  )

  it('folds an offer buffered during the subscribeAll census only when it is published', async () => {
    const { dispatcher, publish, runtime } = harness()
    let resolveCensus = (_value: {
      snapshots: RuntimeMobileSessionTabsResult[]
      changeSequence: number
    }): void => {}
    const census = vi
      .spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCensus = resolve
          })
      )
    const replies: RpcResponse[] = []
    const pending = dispatcher.dispatchStreaming(
      { id: 'buffered', authToken: 'tok', method: 'session.tabs.subscribeAll' },
      (raw) => replies.push(JSON.parse(raw)),
      { clientKind: 'mobile', connectionId: 'buffered' }
    )
    await vi.waitFor(() => expect(census).toHaveBeenCalled())
    expect(runtime.onMobileSessionTabsChanged).toHaveBeenCalled()
    publish(snapshotOf(offeredTab, 2), 1)
    resolveCensus({ snapshots: [snapshotOf(offeredTab)], changeSequence: 0 })
    await pending

    const tab = expectedTab('mobile')
    expect(replies.map(resultOf)).toEqual([
      expect.objectContaining({ snapshots: [expect.objectContaining({ tabs: [tab] })] }),
      expect.objectContaining({ tabs: [tab] })
    ])
  })

  it.each<Audience>(['runtime', 'capable-mobile', 'mobile'])(
    'sends a %s subscriber a frame for an identity-only change',
    async (audience) => {
      const { dispatcher, publish } = harness()
      const replies = await dispatch(dispatcher, 'session.tabs.subscribeAll', undefined, audience)
      const changed = { ...offeredTab, conversationIdentity: { ...identity, capturedAt: 5678 } }

      publish(snapshotOf(changed, 2), 1)

      expect(replies).toHaveLength(2)
      expect(resultOf(replies[1])).toMatchObject({
        tabs: [
          audience === 'mobile'
            ? { agentStatus: { updatedAt: 5678 } }
            : { conversationIdentity: { capturedAt: 5678 } }
        ]
      })
    }
  )

  it('folds each subscription by the capabilities it was opened with', async () => {
    const { dispatcher, publish } = harness()
    const before = await dispatch(
      dispatcher,
      'session.tabs.subscribe',
      { worktree: 'id:wt-1' },
      'capable-mobile'
    )
    const after = await dispatch(
      dispatcher,
      'session.tabs.subscribe',
      { worktree: 'id:wt-1' },
      'mobile'
    )
    publish(snapshotOf(offeredTab, 2), 1)

    expect(before.map(resultOf)).toEqual([
      expect.objectContaining({ tabs: [expectedTab('capable-mobile')] }),
      expect.objectContaining({ tabs: [expectedTab('capable-mobile')] })
    ])
    // Why: a later `runtime.clientCapabilities.update` replaces the connection's array, not this one.
    expect(after.map(resultOf)).toEqual([
      expect.objectContaining({ tabs: [expectedTab('mobile')] }),
      expect.objectContaining({ tabs: [expectedTab('mobile')] })
    ])
  })
})
