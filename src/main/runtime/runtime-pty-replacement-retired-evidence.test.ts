// The P1 from the slice-3 review: a proven replacement retires the pane's live hook claims but
// keeps its resume remnant, and a provider-session-backed Pi remnant then re-projected as the
// successor pane's own `done` row — stamped with the successor handle and the predecessor's
// session. The fixture below is the shape the hook server really produces (providerSessionOnly,
// agentType pi, a provider session), driven through a real AgentHookServer, so the invariant is
// proven against the remnant itself and not against a hand-written row.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  isRetiredPaneEvidenceRow,
  retiredPaneEvidenceFromRow
} from './runtime-retired-pane-evidence'

const REPO_ID = 'repo-retired-evidence'
const WORKTREE_ID = `${REPO_ID}::/tmp/retired-evidence`
const TAB_ID = 'tab-retired-evidence'
const LEAF_ID = '11111111-2222-4333-8444-555555555555'
const PTY_ID = 'pty-retired-evidence'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const OLD_INCARNATION = 'incarnation-predecessor'
const NEW_INCARNATION = 'incarnation-successor'
const AGENT_TITLE = 'π - replacement-test'
const T0 = 1_700_000_000_000
const PREDECESSOR_SESSION = {
  key: 'session_id' as const,
  id: 'predecessor-session',
  transcriptPath: '/transcripts/predecessor.jsonl'
}
const SUCCESSOR_SESSION = {
  key: 'session_id' as const,
  id: 'successor-session',
  transcriptPath: '/transcripts/successor.jsonl'
}

function makeSession(): WorkspaceSessionState {
  const tab: TerminalTab = {
    id: TAB_ID,
    ptyId: PTY_ID,
    worktreeId: WORKTREE_ID,
    title: AGENT_TITLE,
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    }
  } as unknown as WorkspaceSessionState
}

/** The pane's hook row as the hook server stores it: a Pi identity with a resumable session. */
function ingestPiSession(server: AgentHookServer, session: typeof PREDECESSOR_SESSION): void {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      source: 'pi',
      hookEventName: 'UserPromptSubmit',
      providerSession: session,
      payload: { state: 'working', prompt: 'retired-evidence', agentType: 'pi' }
    },
    null
  )
}

function makeRuntime(server: AgentHookServer): OrcaRuntimeService {
  let current = makeSession()
  const store = {
    getRepo: (id: string) =>
      id === REPO_ID ? { id: REPO_ID, path: '/tmp/retired-evidence-repo' } : undefined,
    getRepos: () => [{ id: REPO_ID, path: '/tmp/retired-evidence-repo' }],
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => current,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      current = next
    },
    getSettings: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentProviderSessionRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    reconcileAgentStatusForEndedProcess: (paneKeys, options) =>
      server.reconcileEndedProcessForPaneKeys(paneKeys, options)
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return runtime
}

function registerIncarnation(runtime: OrcaRuntimeService, incarnationId: string): void {
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId
  })
}

/** The predecessor's live stream is itself known-old proof even with no prior binding. */
function feedAgentTitle(runtime: OrcaRuntimeService, incarnationId: string): void {
  runtime.onPtyData(
    PTY_ID,
    `\x1b]0;${AGENT_TITLE}\x07`,
    1,
    20,
    false,
    undefined,
    undefined,
    incarnationId
  )
}

function seedPublishedSurface(runtime: OrcaRuntimeService, title: string, ptyId = PTY_ID): void {
  runtime['storeMobileSessionSnapshot'](WORKTREE_ID, {
    worktree: WORKTREE_ID,
    publicationEpoch: 'headless:test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [],
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId,
        title,
        isActive: false
      }
    ]
  } as never)
}

/** Register the predecessor's own incarnation and publish its title, so a successor replaces it. */
function publishPredecessorPane(runtime: OrcaRuntimeService): void {
  advanceClock(100)
  registerIncarnation(runtime, OLD_INCARNATION)
  feedAgentTitle(runtime, OLD_INCARNATION)
  seedPublishedSurface(runtime, AGENT_TITLE)
}

async function projectedPane(
  runtime: OrcaRuntimeService
): Promise<{ agentStatus?: Record<string, unknown>; terminal: string | null } | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.leafId === LEAF_ID
  )
  if (!tab) {
    return undefined
  }
  const projected = tab as unknown as {
    agentStatus?: Record<string, unknown>
    terminal?: string | null
  }
  return {
    ...(projected.agentStatus ? { agentStatus: projected.agentStatus } : {}),
    terminal: projected.terminal ?? null
  }
}

/** The identity `terminal.list`/`terminal.show` publishes for this pane with no other evidence
 *  (no launch record, no readable foreground process, no title): the hook row decides alone. */
function paneAgentIdentity(runtime: OrcaRuntimeService): string | undefined {
  return (
    runtime as unknown as {
      resolvePaneAgentIdentityField: (
        launchAgent: null,
        foregroundAgent: null,
        title: null,
        paneKey: string
      ) => { agentIdentity?: string }
    }
  ).resolvePaneAgentIdentityField(null, null, null, PANE_KEY).agentIdentity
}

function paneHookRow(server: AgentHookServer): AgentStatusIpcPayload | undefined {
  return server.getStatusSnapshotForPane(PANE_KEY)[0]
}

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
}

let server: AgentHookServer
let userDataDir: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-retired-evidence-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: userDataDir })
})

afterEach(() => {
  server.stop()
  rmSync(userDataDir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('retired pane evidence matching', () => {
  const retiredRow = (): AgentStatusIpcPayload =>
    ({
      paneKey: PANE_KEY,
      state: 'idle',
      prompt: '',
      agentType: 'pi',
      connectionId: null,
      receivedAt: T0,
      stateStartedAt: T0,
      providerSession: PREDECESSOR_SESSION
    }) as unknown as AgentStatusIpcPayload

  it('matches only the recorded row instance, never a same-shape successor row', () => {
    const evidence = retiredPaneEvidenceFromRow(retiredRow())
    expect(evidence).not.toBeNull()
    expect(isRetiredPaneEvidenceRow(retiredRow(), evidence!)).toBe(true)
    // A successor's own row is a later ingestion of the same shape, and cannot be matched.
    expect(isRetiredPaneEvidenceRow({ ...retiredRow(), receivedAt: T0 + 1 }, evidence!)).toBe(false)
    // Server-side rewrites (reconcile, alias migration) keep the ingestion stamp, so a repaint of
    // the same retired instance is still that instance.
    expect(isRetiredPaneEvidenceRow({ ...retiredRow(), state: 'working' }, evidence!)).toBe(true)
    // Nor can a row of the same instant that claims another identity.
    expect(
      isRetiredPaneEvidenceRow({ ...retiredRow(), providerSession: SUCCESSOR_SESSION }, evidence!)
    ).toBe(false)
    expect(isRetiredPaneEvidenceRow({ ...retiredRow(), agentType: 'claude' }, evidence!)).toBe(
      false
    )
  })

  it('tells a same-millisecond successor row apart by its own observation', () => {
    const observation = {
      origin: 'hook' as const,
      authorityId: 'main-agent-hooks:test',
      incarnation: 0,
      revision: 41,
      observedAt: T0
    }
    const retired = { ...retiredRow(), observation }
    const evidence = retiredPaneEvidenceFromRow(retired as AgentStatusIpcPayload)
    expect(evidence).not.toBeNull()
    // The same row instance is still the retired instance...
    expect(isRetiredPaneEvidenceRow(retired as AgentStatusIpcPayload, evidence!)).toBe(true)
    // ...while a successor row sharing the millisecond, the session and the agent type is its own
    // later observation and must not be hidden.
    const successor = { ...retired, observation: { ...observation, revision: 42 } }
    expect(isRetiredPaneEvidenceRow(successor as AgentStatusIpcPayload, evidence!)).toBe(false)
  })
})

describe('retired predecessor evidence on a replaced pane', () => {
  it('projects the Pi resume identity while nothing replaced the pane', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)

    const pane = await projectedPane(runtime)

    // The #12346 carve-out: identity-only Pi evidence still addresses this pane's transcript.
    expect(pane?.agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'pi',
        providerSession: PREDECESSOR_SESSION,
        terminalHandle: pane?.terminal
      })
    )
    expect(paneAgentIdentity(runtime)).toBe('pi')
  })

  it('projects no agent status for the successor of a proven replacement', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)
    advanceClock(100)

    registerIncarnation(runtime, NEW_INCARNATION)

    const pane = await projectedPane(runtime)

    // The pane is live and would carry a status if any of its evidence were its own.
    expect(pane?.terminal).toBeTruthy()
    expect(pane).not.toHaveProperty('agentStatus')
    // The hook row itself is untouched: resume must still reach the retired process's session.
    const remnant = paneHookRow(server)
    expect(remnant?.providerSessionOnly).toBe(true)
    expect(remnant?.agentType).toBe('pi')
    expect(remnant?.providerSession).toEqual(PREDECESSOR_SESSION)
    expect(paneAgentIdentity(runtime)).toBeUndefined()
  })

  it('projects the successor own live row and its own provider session', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)
    advanceClock(100)
    registerIncarnation(runtime, NEW_INCARNATION)

    // The successor's own agent claims the pane again, the way a live Pi does.
    advanceClock(100)
    ingestPiSession(server, SUCCESSOR_SESSION)
    const live = await projectedPane(runtime)

    expect(live?.agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'pi',
        providerSession: SUCCESSOR_SESSION,
        terminalHandle: live?.terminal
      })
    )
    expect(paneAgentIdentity(runtime)).toBe('pi')

    // The successor's own row may later become identity-only itself: it is a different ingestion
    // instance than the retired one, so it stays this pane's evidence while the retired one does.
    server.dropStatusEntry(PANE_KEY)
    expect(paneHookRow(server)?.providerSessionOnly).toBe(true)
    const retained = await projectedPane(runtime)

    expect(retained?.agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'pi',
        providerSession: SUCCESSOR_SESSION,
        terminalHandle: retained?.terminal
      })
    )
  })

  it('keeps the successor own live row when it shares the retired row’s millisecond', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)
    advanceClock(100)
    registerIncarnation(runtime, NEW_INCARNATION)

    // A resumed successor reuses the provider session and its first event lands in the same
    // millisecond stamp as the retired row: only its own observation can tell the rows apart.
    vi.setSystemTime(T0)
    ingestPiSession(server, PREDECESSOR_SESSION)

    const live = await projectedPane(runtime)

    expect(live?.agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'pi',
        providerSession: PREDECESSOR_SESSION,
        terminalHandle: live?.terminal
      })
    )
    expect(paneAgentIdentity(runtime)).toBe('pi')
  })

  it('keeps the retired evidence while the successor owns the pane', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)
    advanceClock(100)

    registerIncarnation(runtime, NEW_INCARNATION)

    const evidenceOf = (paneKey: string): unknown =>
      (
        runtime as unknown as {
          getRetiredPaneEvidence: (key: string) => unknown
        }
      ).getRetiredPaneEvidence(paneKey)
    expect(evidenceOf(PANE_KEY)).not.toBeNull()
    // Scoped to the pane that was replaced: another pane's row can never be filtered by it.
    expect(evidenceOf(makePaneKey(TAB_ID, '22222222-2222-4222-8222-222222222222'))).toBeNull()
  })

  it('leaves a same-incarnation reattach and an untagged pane untouched', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    publishPredecessorPane(runtime)

    // A reconnect that names the same incarnation replaces nothing.
    advanceClock(100)
    registerIncarnation(runtime, OLD_INCARNATION)
    expect(await projectedPane(runtime)).toEqual(
      expect.objectContaining({
        agentStatus: expect.objectContaining({
          agentType: 'pi',
          providerSession: PREDECESSOR_SESSION
        })
      })
    )

    // A registration that cannot name its incarnation has no known-new half of the proof.
    advanceClock(100)
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    expect(await projectedPane(runtime)).toEqual(
      expect.objectContaining({
        agentStatus: expect.objectContaining({
          agentType: 'pi',
          providerSession: PREDECESSOR_SESSION
        })
      })
    )
  })
})

// The sibling of the retired-restore-seed fence: an unconfirmed SSH exit is loss of contact, not
// certified death, so the pane's retired-row fence must outlive the teardown with it. Otherwise the
// replaced process's row re-projects onto a successor the host never proved dead.
describe('retired predecessor evidence across a recoverable SSH relay loss', () => {
  const SSH_PTY_ID = 'ssh:conn-1@@relay-9'
  const SSH_CONNECTION_ID = 'conn-1'

  function registerSshIncarnation(runtime: OrcaRuntimeService, incarnationId: string): void {
    runtime.registerPty(SSH_PTY_ID, WORKTREE_ID, SSH_CONNECTION_ID, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId
    })
  }

  function feedSshAgentTitle(runtime: OrcaRuntimeService, incarnationId: string): void {
    runtime.onPtyData(
      SSH_PTY_ID,
      `\x1b]0;${AGENT_TITLE}\x07`,
      1,
      20,
      false,
      undefined,
      undefined,
      incarnationId
    )
  }

  function retiredEvidenceOf(runtime: OrcaRuntimeService): unknown {
    return (
      runtime as unknown as { getRetiredPaneEvidence: (paneKey: string) => unknown }
    ).getRetiredPaneEvidence(PANE_KEY)
  }

  /** The successor SSH PTY owns a pane whose predecessor row is still stored for resume. */
  function replacedSshPane(runtime: OrcaRuntimeService): void {
    advanceClock(100)
    registerSshIncarnation(runtime, OLD_INCARNATION)
    feedSshAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE, SSH_PTY_ID)
    advanceClock(100)
    registerSshIncarnation(runtime, NEW_INCARNATION)
  }

  it('keeps the retired-row fence through an unconfirmed SSH exit', async () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    replacedSshPane(runtime)
    expect(retiredEvidenceOf(runtime)).not.toBeNull()

    // No host-confirmed exit and an abnormal code: the pane keeps the successor's surface through
    // the reconnect grace, so it must keep the fence that stops the replaced process's row
    // projecting onto that surface.
    runtime.onPtyExit(SSH_PTY_ID, -1)

    // Soft so the red run also shows the consequence below, not just the lost record.
    expect.soft(retiredEvidenceOf(runtime)).not.toBeNull()
    const pane = await projectedPane(runtime)
    expect(pane).toBeDefined()
    expect(pane).not.toHaveProperty('agentStatus')
    // The row itself is untouched: resume must still reach the retired process's session.
    expect(paneHookRow(server)?.providerSession).toEqual(PREDECESSOR_SESSION)
  })

  it('releases the retired-row fence on a certified exit', () => {
    const runtime = makeRuntime(server)
    ingestPiSession(server, PREDECESSOR_SESSION)
    replacedSshPane(runtime)
    expect(retiredEvidenceOf(runtime)).not.toBeNull()

    // A reported exit certifies the successor's death, so the pane no longer needs the fence.
    runtime.onPtyExit(SSH_PTY_ID, 0)

    expect(retiredEvidenceOf(runtime)).toBeNull()
  })
})
