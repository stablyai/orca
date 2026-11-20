import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsResult
} from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { RpcDispatcher } from '../../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import './session-tabs-retirement-proof-delta'

const WORKTREE = 'wt-proofs'

function frame(
  snapshotVersion: number,
  retiredTerminalSurfaces?: RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    ...(retiredTerminalSurfaces ? { retiredTerminalSurfaces } : {}),
    tabs: []
  }
}

describe('session.tabs.subscribe retirement proof payload', () => {
  const proofs: RuntimeMobileSessionRetiredTerminalSurface[] = [
    {
      parentTabId: 'terminal-tab',
      leafId: 'leaf',
      ptyId: 'pty',
      terminal: 'term_handle',
      incarnationId: 'incarnation'
    }
  ]

  async function subscribeAndTick(clientCapabilities: readonly string[] | undefined): Promise<{
    initial: string
    tick: string
  }> {
    let listener: ((snapshot: RuntimeMobileSessionTabsResult) => void) | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: () => ({}),
      listMobileSessionTabs: vi.fn().mockResolvedValue(frame(1, proofs)),
      registerSubscriptionCleanup: vi.fn(),
      onMobileSessionTabsChanged: vi.fn(
        (next: (snapshot: RuntimeMobileSessionTabsResult) => void) => {
          listener = next
          return () => {}
        }
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:wt' }
      },
      (message) => messages.push(message),
      { clientKind: 'runtime', clientCapabilities }
    )
    listener!(frame(2, proofs))
    return { initial: messages[0]!, tick: messages[1]! }
  }

  it('drops a repeated proof from a later snapshot for a negotiated client', async () => {
    const legacy = await subscribeAndTick(undefined)
    const delta = await subscribeAndTick([SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY])

    const legacyTick = JSON.parse(legacy.tick).result
    const deltaTick = JSON.parse(delta.tick).result
    expect(legacyTick.retiredTerminalSurfaces).toEqual(proofs)
    expect(deltaTick.retiredTerminalSurfaces).toEqual([])
    expect(JSON.parse(legacy.initial).result.retiredTerminalSurfaces).toEqual(proofs)
    expect(JSON.parse(delta.initial).result.retiredTerminalSurfaces).toEqual(proofs)
  })
})
