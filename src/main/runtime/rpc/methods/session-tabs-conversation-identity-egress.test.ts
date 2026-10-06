// The private conversation identity carrier reaches the wire only as a phone's agentStatus: every
// tab-bearing egress is driven through the real dispatcher and JSON, for every audience.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import {
  buildMobileConversationIdentityCarrier,
  withMobileConversationIdentityCarrier
} from '../../mobile-conversation-identity-carrier'
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

const carrier = buildMobileConversationIdentityCarrier({
  candidate: {
    providerSession: { key: 'session_id', id: 'codex-session', transcriptPath: '/r.jsonl' },
    sessionAgent: 'codex',
    observedAt: 1234
  },
  ownerAgent: 'codex',
  ownerOptions: { ownerIsLaunch: true },
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  terminalTitle: 'Say hi | my-repo',
  terminalHandle: 'term-1',
  worktreeId: 'wt-1'
})
if (!carrier) {
  throw new Error('expected a carrier')
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
const carrierTab = withMobileConversationIdentityCarrier(statuslessTab, carrier)

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
  vi.spyOn(runtime, 'listMobileSessionTabs').mockResolvedValue(snapshotOf(carrierTab))
  vi.spyOn(runtime, 'listAllMobileSessionTabs').mockResolvedValue([snapshotOf(carrierTab)])
  vi.spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence').mockResolvedValue({
    snapshots: [snapshotOf(carrierTab)],
    changeSequence: 0
  })
  vi.spyOn(runtime, 'supportsAuthoritativeSessionTabsInventory').mockReturnValue(false)
  vi.spyOn(runtime, 'activateMobileSessionTab').mockResolvedValue(snapshotOf(carrierTab))
  vi.spyOn(runtime, 'createMobileSessionTerminal').mockResolvedValue({
    tab: carrierTab,
    publicationEpoch: 'headless:1',
    snapshotVersion: 1
  })
  vi.spyOn(runtime, 'adoptTerminalOrphans').mockResolvedValue({
    adopted: false,
    topologyRevision: 1,
    snapshot: snapshotOf(carrierTab)
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
  clientKind: ClientKind
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: method, authToken: 'tok', method, params },
    (raw) => replies.push(JSON.parse(raw)),
    { clientKind, connectionId: `conn-${String(clientKind)}` }
  )
  expect(replies[0]?.ok).toBe(true)
  return replies
}

function resultOf(reply: RpcResponse | undefined): unknown {
  return reply?.ok ? reply.result : undefined
}

/** The terminal tab exactly as the audience should receive it. */
function expectedTab(clientKind: ClientKind): unknown {
  return JSON.parse(
    JSON.stringify(
      clientKind === 'mobile' ? { ...statuslessTab, agentStatus: carrier } : statuslessTab
    )
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('conversation identity carrier egress', () => {
  it.each<ClientKind>(['mobile', 'runtime', undefined])(
    'publishes the carrier on every folded session.tabs route only to a phone (%s)',
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
      publish(snapshotOf(carrierTab, 2), 1)
      expect(subscribed.map(resultOf)).toEqual([
        expect.objectContaining({ tabs: [tab] }),
        expect.objectContaining({ tabs: [tab] })
      ])
      expect(
        resultOf((await dispatch(dispatcher, 'session.tabs.listAll', undefined, clientKind))[0])
      ).toMatchObject({ snapshots: [{ tabs: [tab] }] })
      const all = await dispatch(dispatcher, 'session.tabs.subscribeAll', undefined, clientKind)
      publish(snapshotOf(carrierTab, 3), 2)
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

  it.each<ClientKind>(['mobile', 'runtime', undefined])(
    'sends the unfolded create and adopt results with no carrier or extra key (%s)',
    async (clientKind) => {
      const { dispatcher } = harness()
      const statusless = JSON.parse(JSON.stringify(statuslessTab))

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

  it('folds a carrier buffered during the subscribeAll census only when it is published', async () => {
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
    publish(snapshotOf(carrierTab, 2), 1)
    resolveCensus({ snapshots: [snapshotOf(carrierTab)], changeSequence: 0 })
    await pending

    const tab = expectedTab('mobile')
    expect(replies.map(resultOf)).toEqual([
      expect.objectContaining({ snapshots: [expect.objectContaining({ tabs: [tab] })] }),
      expect.objectContaining({ tabs: [tab] })
    ])
  })

  it('sends a runtime subscriber no extra frame for a carrier-only change', async () => {
    const { dispatcher, publish } = harness()
    const replies = await dispatch(dispatcher, 'session.tabs.subscribeAll', undefined, 'runtime')
    const changedCarrier = { ...carrier, updatedAt: 5678, stateStartedAt: 5678 }

    publish(snapshotOf(withMobileConversationIdentityCarrier(statuslessTab, changedCarrier)), 1)
    publish(snapshotOf(statuslessTab), 2)

    expect(replies).toHaveLength(1)
  })
})
