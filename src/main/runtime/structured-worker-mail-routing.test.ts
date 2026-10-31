import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } =
  await import('./terminal/adoption/adopt-terminal-orphans-from-inventory')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const prototype = OrcaRuntimeWithAdoptTerminalOrphansFromInventory.prototype
const getLivePaneKey = prototype.getLiveTerminalPaneKey
const resolveActiveTerminal = prototype.resolveActiveTerminal

function installRecord(
  lease: Pick<AgentSessionLease, 'runtimeKind' | 'claimStatus'> | null,
  tabListed = false
): void {
  hostRef.current = lease
    ? {
        getPersistedVisibleSessionTabIndex: () => ({
          present: true,
          sessionIds: tabListed ? [SESSION_ID] : []
        }),
        deps: {
          store: {
            getConversation: () =>
              agentSessionConversationView(
                agentSessionRecordFixture(
                  agentSessionLeaseFixture({
                    ...lease,
                    sessionId: SESSION_ID,
                    runtimeFence: 1,
                    deathEvidence: null
                  })
                )
              )
          }
        },
        hasSession: () => lease.claimStatus === 'live'
      }
    : null
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

const paneKeyStub = {
  getOrchestrationDbIfAvailable: () => null,
  getLivePtyForHandle: () => null,
  resolveLiveLeafForHandle: () => null,
  ptysById: new Map(),
  getPaneKeyForTerminalHandle: () => null
}

describe('bare-handle direct mail to a structured session', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('resolves a live pane key, so recipient routing does not answer terminal_not_found', () => {
    // resolveBareOrchestrationRecipient reads this getter, not getTerminalPaneKey.
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBe(
      structuredWorkerIdentities.get(handle)!.paneKey
    )
  })

  it('routes to a worker at rest, whose agent the mail starts', () => {
    // Released by the idle sweep with its chat tab still listed: owned, so mail reaches it.
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'released' }, true)
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBe(
      structuredWorkerIdentities.get(handle)!.paneKey
    )
  })

  it('withholds the pane key from a retired worker: released, with its tab gone', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'released' }, false)
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBeNull()
  })

  it('withholds the pane key when a terminal an older build recorded holds the lease', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'conflicted' })
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBeNull()
  })
})

describe('implicit sender resolution refuses to guess', () => {
  function senderStub(leafIds: readonly string[]) {
    return {
      graphStatus: 'ready',
      assertGraphReady: () => {},
      resolveWorkspaceSelector: async () => ({ id: 'wt_1' }),
      tabs: new Map(),
      leaves: new Map(
        leafIds.map((leafId) => [leafId, { tabId: 'tab_1', leafId, worktreeId: 'wt_1' }])
      ),
      issueHandle: (leaf: { leafId: string }) => `term_${leaf.leafId}`
    }
  }

  it('returns the only candidate leaf', async () => {
    await expect(
      resolveActiveTerminal.call(senderStub(['leaf_a']), 'id:wt_1', { requireUnambiguous: true })
    ).resolves.toBe('term_leaf_a')
  })

  it('refuses rather than picking the first of several', async () => {
    // An arbitrary sender guess can settle a sibling's context-only Dispatch, which has no capability token to reject it.
    await expect(
      resolveActiveTerminal.call(senderStub(['leaf_a', 'leaf_b']), 'id:wt_1', {
        requireUnambiguous: true
      })
    ).rejects.toThrow('no_active_terminal')
  })

  it('refuses the same arbitrary pick before the terminal graph is ready', async () => {
    // Keep a focused terminal in the starting graph so only the pre-ready identity guard can refuse this request.
    const preReady = {
      graphStatus: 'starting',
      resolveWorkspaceSelector: async () => ({ id: 'wt_1' }),
      getMobileSessionTabsForWorktree: () => ({
        tabs: [{ type: 'terminal', isActive: true, status: 'ready', terminal: 'term_focused' }]
      }),
      listTerminals: async () => ({ terminals: [{ handle: 'term_a' }, { handle: 'term_b' }] })
    }
    await expect(
      resolveActiveTerminal.call(preReady, 'id:wt_1', { requireUnambiguous: true })
    ).rejects.toThrow('no_active_terminal')
    // The same stub still answers the focus guess for a caller that is not claiming an identity.
    await expect(resolveActiveTerminal.call(preReady, 'id:wt_1')).resolves.toBe('term_focused')
  })

  it('still picks arbitrarily for callers that are not claiming an identity', async () => {
    await expect(
      resolveActiveTerminal.call(senderStub(['leaf_a', 'leaf_b']), 'id:wt_1')
    ).resolves.toBe('term_leaf_a')
  })
})
