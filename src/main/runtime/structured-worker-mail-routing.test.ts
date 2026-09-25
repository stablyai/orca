import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } =
  await import('./orca-runtime-adopt-terminal-orphans-from-inventory')
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

function installRecord(lease: { runtimeKind: string; claimStatus: string } | null): void {
  hostRef.current = lease
    ? {
        deps: {
          store: {
            getRecord: () => ({
              location: { executionHostId: 'local', wslDistro: null },
              lease: { ...lease, runtimeFence: 1, deathEvidence: null }
            })
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

  it('withholds the pane key when the session is not proven live', () => {
    // The PTY branch is connected-gated so mail is never routed to a corpse; so is this one.
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'reserved' })
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBeNull()
  })

  it('withholds the pane key when the lease moved to a terminal owner', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'tui', claimStatus: 'live' })
    expect(getLivePaneKey.call(paneKeyStub, handle)).toBeNull()
  })
})

describe('implicit sender resolution refuses to guess', () => {
  function senderStub(leafIds: readonly string[]) {
    return {
      graphStatus: 'ready',
      assertGraphReady: () => {},
      resolveWorktreeSelector: async () => ({ id: 'wt_1' }),
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
    // An arbitrary pick lets a bare `send --type worker_done` settle a SIBLING's context-only
    // dispatch, a tier that has no capability token to reject on.
    await expect(
      resolveActiveTerminal.call(senderStub(['leaf_a', 'leaf_b']), 'id:wt_1', {
        requireUnambiguous: true
      })
    ).rejects.toThrow('no_active_terminal')
  })

  it('refuses the same arbitrary pick before the terminal graph is ready', async () => {
    // The snapshot carries a focused terminal on purpose: without it the refusal below would come
    // from the ambiguous `listTerminals` fallback alone and would still hold with the pre-ready
    // focus guess left in, proving nothing about it.
    const preReady = {
      graphStatus: 'starting',
      resolveWorktreeSelector: async () => ({ id: 'wt_1' }),
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
