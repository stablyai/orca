import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { createSessionTabsRetirementProofDelta } from './session-tabs-retirement-proof-delta'

const WORKTREE = 'wt-proofs'

function proof(index: number): RuntimeMobileSessionRetiredTerminalSurface {
  return {
    parentTabId: `tab-${index}`,
    leafId: `leaf-${index}`,
    ptyId: `pty-${index}`,
    terminal: `term_${index}`,
    incarnationId: `inc-${index}`
  }
}

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

describe('session tabs retirement proof delta', () => {
  it('passes every frame through untouched for a client that did not negotiate it', () => {
    const project = createSessionTabsRetirementProofDelta(undefined)
    const full = frame(1, [proof(1), proof(2)])
    expect(project(full)).toBe(full)
    expect(project(frame(2, [proof(1), proof(2)]))).toEqual(frame(2, [proof(1), proof(2)]))
  })

  // Why `[]` rather than omitting the field: absence is the host's "I hold no proofs" signal and
  // tells the client to forget, so a delta with nothing new must stay distinguishable from it.
  it('sends each proof once and an empty list when nothing is new', () => {
    const project = createSessionTabsRetirementProofDelta([
      SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
    ])
    expect(project(frame(1, [proof(1)]))).toEqual(frame(1, [proof(1)]))
    expect(project(frame(2, [proof(1)]))).toEqual(frame(2, []))
    expect(project(frame(3, [proof(1), proof(2)]))).toEqual(frame(3, [proof(2)]))
    expect(project(frame(4, [proof(1), proof(2)]))).toEqual(frame(4, []))
  })

  it('resends a proof that left the host list and came back', () => {
    const project = createSessionTabsRetirementProofDelta([
      SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
    ])
    project(frame(1, [proof(1)]))
    // Surface revived: the host dropped the proof and publishes an empty list.
    expect(project(frame(2, []))).toEqual(frame(2, []))
    expect(project(frame(3, [proof(1)]))).toEqual(frame(3, [proof(1)]))
  })

  it('starts over for a worktree after a removed frame or a proof-less host', () => {
    const project = createSessionTabsRetirementProofDelta([
      SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
    ])
    project(frame(1, [proof(1)]))
    project({ ...frame(2), removed: true } as RuntimeMobileSessionTabsResult)
    expect(project(frame(3, [proof(1)]))).toEqual(frame(3, [proof(1)]))
    project(frame(4))
    expect(project(frame(5, [proof(1)]))).toEqual(frame(5, [proof(1)]))
  })
})

// Why: the host pins up to 64 proofs per worktree for its lifetime, so this is the steady-state
// cost of every title tick on a churn-heavy worktree for a paired mobile/relay/SSH client.
describe('session.tabs.subscribe retirement proof payload', () => {
  // Real identities are UUID-sized: tab/leaf/pty ids and `term_<uuid>` handles.
  const uuid = (index: number): string =>
    `${index.toString(16).padStart(8, '0')}-4a1b-4c2d-8e3f-000000000000`
  const proofs = Array.from({ length: 64 }, (_, index) => ({
    parentTabId: `terminal-${uuid(index)}`,
    leafId: uuid(index + 1000),
    ptyId: uuid(index + 2000),
    terminal: `term_${uuid(index + 3000)}`,
    incarnationId: uuid(index + 4000)
  }))

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
    // An OSC title change bumps the version and republishes the same 64 proofs.
    listener!(frame(2, proofs))
    return { initial: messages[0]!, tick: messages[1]! }
  }

  // Why: a reconnect is a new subscribe with fresh per-stream state, and the client's ledger
  // resets on its new connection generation — so the first frame must carry the full set.
  it('resends the full proof set on the first frame of a fresh stream', async () => {
    const first = await subscribeAndTick([SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY])
    const reconnected = await subscribeAndTick([
      SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
    ])
    expect(JSON.parse(first.initial).result.retiredTerminalSurfaces).toEqual(proofs)
    expect(JSON.parse(reconnected.initial).result.retiredTerminalSurfaces).toEqual(proofs)
  })

  it('drops the repeated proof list from a title tick for a negotiated client', async () => {
    const legacy = await subscribeAndTick(undefined)
    const delta = await subscribeAndTick([SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY])

    const legacyTick = JSON.parse(legacy.tick).result
    const deltaTick = JSON.parse(delta.tick).result
    expect(legacyTick.retiredTerminalSurfaces).toHaveLength(64)
    expect(deltaTick.retiredTerminalSurfaces).toEqual([])
    // Both clients still receive the full list on the initial snapshot.
    expect(JSON.parse(legacy.initial).result.retiredTerminalSurfaces).toHaveLength(64)
    expect(JSON.parse(delta.initial).result.retiredTerminalSurfaces).toHaveLength(64)

    // The delta tick keeps a two-byte `[]` so the client can tell "nothing new" from "no proofs".
    const proofBytes = Buffer.byteLength(JSON.stringify(proofs))
    expect(proofBytes).toBeGreaterThan(8_000)
    expect(Buffer.byteLength(legacy.tick) - Buffer.byteLength(delta.tick)).toBe(proofBytes - 2)
  })
})
