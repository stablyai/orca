// The store keeps a pane's conversation as a facet beside its status: only an incoming report that
// admission kept can move it, and every legacy output stays as it was.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { admitLegacyAgentStatus } from '../../shared/agent-hook-listener/listener-state'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../shared/agent-status-legacy-adapter'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { EnrichedAgentHookEventPayload, StoredAgentConversation } from './server/server-types'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

const SSH = 'ssh-1'
const S: AgentProviderSessionMetadata = { key: 'session_id', id: 'S', transcriptPath: '/r/S.jsonl' }
const T: AgentProviderSessionMetadata = { key: 'session_id', id: 'T', transcriptPath: '/r/T.jsonl' }
const C: AgentProviderSessionMetadata = { key: 'session_id', id: 'C' }

let cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.toReversed()) {
    cleanup()
  }
  cleanups = []
})

function store(): AgentHookServer {
  const server = new AgentHookServer()
  cleanups.push(() => server.stop())
  return server
}

type Remote = {
  source?: string
  hookEventName?: string
  toolAgentId?: string
  providerSession?: AgentProviderSessionMetadata
  providerSessionOnly?: true
  isReplay?: true
  payload: Record<string, unknown>
}

function remote(server: AgentHookServer, event: Remote): void {
  server.ingestRemote(
    { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', source: 'claude', ...event },
    SSH
  )
}

function report(
  server: AgentHookServer,
  state: AgentStatusState,
  providerSession: AgentProviderSessionMetadata | undefined,
  extra: Record<string, unknown> = {},
  agentType = 'claude'
): void {
  remote(server, {
    source: agentType,
    ...(providerSession ? { providerSession } : {}),
    payload: { state, agentType, prompt: 'Say hi', ...extra }
  })
}

function osc(server: AgentHookServer, state: AgentStatusState, agentType = 'claude'): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    connectionId: SSH,
    payload: { state, agentType, prompt: '' }
  })
}

function facet(server: AgentHookServer): StoredAgentConversation | undefined {
  return server.getConversationIdentityForPane(PANE)?.facet
}

function legacySession(server: AgentHookServer): AgentProviderSessionMetadata | undefined {
  return server.getStatusSnapshotForPane(PANE)[0]?.providerSession
}

function mutations(server: AgentHookServer): { count: () => number } {
  let count = 0
  const detach = server.subscribeStatusRowMutations(() => {
    count += 1
  })
  cleanups.push(detach)
  return { count: () => count }
}

/** The nested-agent owner rule #24297 adds, reduced to what it does to the admitted address. */
class OwnerRuleServer extends AgentHookServer {
  protected override attachStatusTiming(
    payload: AgentHookEventPayload,
    now?: number,
    observedAt?: number
  ): EnrichedAgentHookEventPayload {
    const previous = this._getStateForTests().lastStatusByPaneKey.get(payload.paneKey)
    const borrowed =
      previous && payload.toolAgentId && previous.payload.agentType === payload.payload.agentType
        ? previous.providerSession
        : undefined
    return super.attachStatusTiming(
      borrowed ? { ...payload, providerSession: borrowed } : payload,
      now,
      observedAt
    )
  }
}

function clock(start: number): { tick: (ms?: number) => number } {
  let now = start
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return {
    tick: (ms = 1_000) => {
      now += ms
      return now
    }
  }
}

describe('the conversation facet survives status edges', () => {
  it('keeps S across the done -> OSC working edge that drops the legacy address', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S)
    time.tick()
    report(server, 'done', S)
    const kept = facet(server)
    time.tick()
    osc(server, 'working')

    expect(legacySession(server)).toBeUndefined()
    expect(facet(server)).toBe(kept)
    expect(facet(server)).toMatchObject({ agentType: 'claude', providerSession: S })
  })

  it('keeps S through hooks that carry no session id', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'done', S)
    const kept = facet(server)
    for (const [state, extra] of [
      ['working', {}],
      ['working', { toolName: 'Bash' }],
      ['waiting', { toolName: 'AskUserQuestion' }],
      ['done', {}]
    ] as const satisfies readonly (readonly [AgentStatusState, Record<string, unknown>])[]) {
      time.tick()
      report(server, state, undefined, extra)
      expect(facet(server)).toBe(kept)
    }
  })

  it('leaves the facet and its clock alone across same-status OSC refreshes', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S)
    const kept = facet(server)
    // Why one OSC first: it is a genuine change (the prompt clears); only repeats are refreshes.
    time.tick()
    osc(server, 'working')
    const seen = mutations(server)
    for (let index = 0; index < 5; index += 1) {
      time.tick()
      osc(server, 'working')
    }
    expect(facet(server)).toBe(kept)
    expect(seen.count()).toBe(0)
  })
})

describe('only a kept original report moves the facet', () => {
  it('takes a new model for the same address, then repeats move nothing', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const first = facet(server)
    const at = time.tick()
    report(server, 'working', S, { model: 'Q', modelSwitchCommand: 'orca-model' })
    const moved = facet(server)
    expect(moved).toEqual({
      agentType: 'claude',
      providerSession: S,
      model: 'Q',
      modelSwitchCommand: 'orca-model',
      capturedAt: at
    })
    expect(moved).not.toBe(first)
    time.tick()
    report(server, 'working', S, { model: 'Q', modelSwitchCommand: 'orca-model' })
    expect(facet(server)).toBe(moved)
  })

  it('leaves the facet alone for a model report that carries no session', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const kept = facet(server)
    time.tick()
    report(server, 'working', undefined, { model: 'Q' })
    expect(facet(server)).toBe(kept)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.model).toBe('Q')
  })

  it.each([
    ['a new id', T],
    ['the same id at a new path', { ...S, transcriptPath: '/r/elsewhere.jsonl' }],
    ['a new key', { key: 'conversation_id' as const, id: 'S', transcriptPath: S.transcriptPath }]
  ])('replaces the facet for %s and does not inherit the model', (_name, next) => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const at = time.tick()
    report(server, 'working', next)
    expect(facet(server)).toEqual({ agentType: 'claude', providerSession: next, capturedAt: at })
  })

  it('returns the same facet for an identical report three times, with no facet-caused mutation', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'done', S, { model: 'P' })
    const kept = facet(server)
    const legacyBefore = server.getStatusSnapshotForPane(PANE)[0]
    for (let index = 0; index < 3; index += 1) {
      time.tick()
      report(server, 'done', S, { model: 'P' })
      expect(facet(server)).toBe(kept)
    }
    expect(kept?.capturedAt).toBe(legacyBefore?.receivedAt)
  })
})

describe('carried-forward writes never report', () => {
  it.each<AgentStatusState>(['done', 'waiting'])(
    'an OSC working -> %s edge with the copied address moves nothing',
    (state) => {
      const time = clock(1_700_000_000_000)
      const server = store()
      report(server, 'working', S, { model: 'P' })
      const kept = facet(server)
      time.tick()
      osc(server, state)
      expect(legacySession(server)).toEqual(S)
      expect(facet(server)).toBe(kept)
    }
  )

  it('an OSC copy of an address the facet does not hold never replaces the facet', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const otherFacet: StoredAgentConversation = {
      agentType: 'claude',
      providerSession: T,
      capturedAt: 5
    }
    seedRow(server, (row) => ({ ...row, conversation: otherFacet }))
    const seeded = facet(server)
    time.tick()
    osc(server, 'done')
    expect(legacySession(server)).toEqual(S)
    expect(facet(server)).toBe(seeded)
  })

  it('an OSC copy on a facet-less row seeds only from that row, never a newer address', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S)
    seedRow(server, ({ conversation: _conversation, ...row }) => ({ ...row, receivedAt: 7 }))
    time.tick()
    osc(server, 'done')
    expect(legacySession(server)).toEqual(S)
    expect(server.getConversationIdentityForPane(PANE)).toEqual({
      facet: { agentType: 'claude', providerSession: S, capturedAt: 7 },
      rowAgent: 'claude',
      rowIsRemnant: false
    })
  })

  it('an interrupt inference on a row with S moves nothing', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const kept = facet(server)
    const row = server.getStatusSnapshotForPane(PANE)[0]!
    time.tick()
    const inferred = server.inferInterrupt({
      paneKey: PANE,
      intent: 'ctrl-c',
      inputCount: 1,
      baselineAgentType: 'claude',
      baselinePrompt: row.prompt ?? '',
      baselineUpdatedAt: row.receivedAt,
      baselineStateStartedAt: row.stateStartedAt
    })
    expect(inferred).toBe(true)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')
    expect(facet(server)).toBe(kept)
  })

  it('a question-answered inference on a row with S moves nothing', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'waiting', S, { toolName: 'AskUserQuestion', model: 'P' })
    const kept = facet(server)
    const row = server.getStatusSnapshotForPane(PANE)[0]!
    time.tick()
    server.inferQuestionAnswered({
      paneKey: PANE,
      baselineAgentType: 'claude',
      baselinePrompt: row.prompt ?? '',
      baselineUpdatedAt: row.receivedAt,
      baselineStateStartedAt: row.stateStartedAt
    })
    expect(facet(server)).toBe(kept)
  })
})

function childPermission(providerSession: AgentProviderSessionMetadata, model: string): Remote {
  return {
    hookEventName: 'PermissionRequest',
    toolAgentId: 'child-a',
    providerSession,
    payload: {
      state: 'waiting',
      agentType: 'claude',
      prompt: 'held',
      model,
      toolName: 'Bash',
      mainAgent: { state: 'done', stateStartedAt: 100 }
    }
  }
}

function parentProgress(providerSession: AgentProviderSessionMetadata, model?: string): Remote {
  return {
    hookEventName: 'PreToolUse',
    providerSession,
    payload: {
      state: 'working',
      agentType: 'claude',
      prompt: 'parent',
      ...(model ? { model } : {}),
      toolName: 'Read',
      mainAgent: { state: 'working', stateStartedAt: 200 }
    }
  }
}

/** Test-only seeding of a row the store could hold, e.g. one written before facets existed. */
function seedRow(
  server: AgentHookServer,
  edit: (row: EnrichedAgentHookEventPayload) => EnrichedAgentHookEventPayload
): void {
  const state = server._getStateForTests()
  const row = state.lastStatusByPaneKey.get(PANE)
  if (!row || !('receivedAt' in row) || !('stateStartedAt' in row)) {
    throw new Error('expected a row to seed')
  }
  const { ...enriched } = row
  admitLegacyAgentStatus(
    state,
    'main-status-update',
    edit({
      ...enriched,
      receivedAt: Number(row.receivedAt),
      stateStartedAt: Number(row.stateStartedAt)
    }),
    AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
  )
}

const facetSP: StoredAgentConversation = {
  agentType: 'claude',
  providerSession: S,
  model: 'P',
  capturedAt: 1
}

describe('held permission rows never report', () => {
  it('keeps the facet when a parent report is held behind a child permission with another address', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    remote(server, {
      hookEventName: 'UserPromptSubmit',
      providerSession: S,
      payload: { state: 'working', agentType: 'claude', prompt: 'parent', model: 'P' }
    })
    time.tick()
    remote(server, {
      hookEventName: 'PermissionRequest',
      toolAgentId: 'child-a',
      providerSession: C,
      payload: {
        state: 'waiting',
        agentType: 'claude',
        prompt: 'held',
        model: 'Q',
        toolName: 'Bash',
        mainAgent: { state: 'done', stateStartedAt: 100 }
      }
    })
    // On main admission keeps the child's address (T8): the facet follows the legacy address.
    expect(legacySession(server)).toEqual(C)
    const afterChild = facet(server)
    expect(afterChild).toMatchObject({ providerSession: C, model: 'Q' })
    time.tick()
    remote(server, {
      hookEventName: 'PreToolUse',
      providerSession: S,
      payload: {
        state: 'working',
        agentType: 'claude',
        prompt: 'parent',
        model: 'R',
        toolName: 'Read',
        mainAgent: { state: 'working', stateStartedAt: 200 }
      }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('waiting')
    expect(facet(server)).toBe(afterChild)
  })

  it.each([
    ['equal to the held model', 'Q'],
    ['equal to the facet model', 'P'],
    ['absent', undefined]
  ])('keeps a same-address facet when the held parent model is %s', (_name, model) => {
    const time = clock(1_700_000_000_000)
    const server = store()
    remote(server, childPermission(S, 'Q'))
    seedRow(server, (row) => ({ ...row, conversation: facetSP }))
    const seeded = facet(server)
    expect(seeded).toEqual(facetSP)
    time.tick()
    remote(server, parentProgress(S, model ?? undefined))
    const held = server.getStatusSnapshotForPane(PANE)[0]
    expect(held).toMatchObject({ state: 'waiting', providerSession: S, model: 'Q' })
    expect(facet(server)).toBe(seeded)
  })

  it('seeds a facet-less held row from the previous row, never from the incoming report', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    remote(server, childPermission(S, 'Q'))
    seedRow(server, ({ conversation: _conversation, ...row }) => row)
    const previous = server.getStatusSnapshotForPane(PANE)[0]
    expect(server.getConversationIdentityForPane(PANE)).toBeUndefined()
    time.tick()
    remote(server, parentProgress(T, 'R'))
    expect(facet(server)).toEqual({
      agentType: 'claude',
      providerSession: S,
      model: 'Q',
      capturedAt: previous?.receivedAt
    })
  })

  it('on main, a child permission sets the facet, and the next unheld parent report replaces it', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    remote(server, {
      hookEventName: 'UserPromptSubmit',
      providerSession: S,
      payload: { state: 'working', agentType: 'claude', prompt: 'parent', model: 'P' }
    })
    time.tick()
    remote(server, childPermission(C, 'Q'))
    expect(facet(server)).toMatchObject({ providerSession: C, model: 'Q' })
    time.tick()
    remote(server, parentProgress(S, 'R'))
    expect(facet(server)).toMatchObject({ providerSession: C, model: 'Q' })
    time.tick()
    remote(server, {
      hookEventName: 'Stop',
      providerSession: S,
      payload: { state: 'done', agentType: 'claude', prompt: 'parent', model: 'R2' }
    })
    expect(legacySession(server)).toEqual(S)
    expect(facet(server)).toMatchObject({ providerSession: S, model: 'R2' })
  })

  it('under an owner rule that substitutes the parent address, the facet keeps S/P (#24297 order)', () => {
    const time = clock(1_700_000_000_000)
    const server = new OwnerRuleServer()
    cleanups.push(() => server.stop())
    remote(server, {
      hookEventName: 'UserPromptSubmit',
      providerSession: S,
      payload: { state: 'working', agentType: 'claude', prompt: 'parent', model: 'P' }
    })
    const parent = facet(server)
    time.tick()
    remote(server, childPermission(C, 'Q'))
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSession: S,
      model: 'Q'
    })
    expect(facet(server)).toBe(parent)
    time.tick()
    remote(server, parentProgress(S, 'R'))
    expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('waiting')
    expect(facet(server)).toBe(parent)
  })
})

describe('the facet follows the legacy address for nested children (T8)', () => {
  it('a named Claude child inside a Codex pane, then a Codex OSC done', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' }, 'codex')
    expect(facet(server)?.providerSession).toEqual(legacySession(server))
    time.tick()
    report(server, 'working', C, { model: 'Q' }, 'claude')
    expect(facet(server)?.providerSession).toEqual(legacySession(server))
    expect(facet(server)?.model).toBe(server.getStatusSnapshotForPane(PANE)[0]?.model)
    const afterChild = facet(server)
    time.tick()
    osc(server, 'done', 'codex')
    expect(facet(server)).toBe(afterChild)
  })

  it('a Pi provider-only session inside a Codex pane, then Pi turns', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, {}, 'codex')
    const piSession = { key: 'session_id' as const, id: 'pi-C', transcriptPath: '/r/pi-C.jsonl' }
    time.tick()
    remote(server, {
      source: 'pi',
      hookEventName: 'session_start',
      providerSessionOnly: true,
      providerSession: piSession,
      payload: { state: 'done', agentType: 'pi', prompt: '' }
    })
    expect(facet(server)?.providerSession).toEqual(legacySession(server))
    time.tick()
    remote(server, {
      source: 'pi',
      hookEventName: 'turn_start',
      providerSession: piSession,
      payload: { state: 'working', agentType: 'pi', prompt: 'child' }
    })
    expect(facet(server)?.providerSession).toEqual(legacySession(server))
  })

  it('a child-first row keeps exactly the legacy address through a status-only write', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    remote(server, {
      source: 'codex',
      toolAgentId: 'child-1',
      providerSession: C,
      payload: { state: 'working', agentType: 'codex', prompt: 'child' }
    })
    expect(facet(server)?.providerSession).toEqual(legacySession(server))
    time.tick()
    report(server, 'working', undefined, {}, 'codex')
    expect(facet(server)?.providerSession).toEqual(C)
  })
})

describe('facet-only publication', () => {
  it('publishes exactly one row mutation when only the facet changes, none on a repeat', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'Q' })
    // The legacy row already says S/Q while the facet still holds S/P (e.g. restored from disk).
    seedRow(server, (row) => ({ ...row, conversation: facetSP }))
    const statusBefore = server.getStatusSnapshotForPane(PANE)[0]
    const seen = mutations(server)
    time.tick()
    report(server, 'working', S, { model: 'Q' })
    expect(facet(server)).toMatchObject({ providerSession: S, model: 'Q' })
    const strip = ({
      receivedAt: _r,
      evidenceObservedAt: _e,
      observation: _o,
      ...rest
    }: Record<string, unknown>) => rest
    expect(strip({ ...server.getStatusSnapshotForPane(PANE)[0] })).toEqual(
      strip({ ...statusBefore })
    )
    expect(seen.count()).toBe(1)
    time.tick()
    report(server, 'working', S, { model: 'Q' })
    expect(seen.count()).toBe(1)
  })
})

describe('eviction', () => {
  it('drops the facet with the row on close and on a certified exit', () => {
    clock(1_700_000_000_000)
    const closed = store()
    report(closed, 'done', S)
    closed.clearPaneState(PANE)
    expect(closed.getConversationIdentityForPane(PANE)).toBeUndefined()

    const exited = store()
    report(exited, 'working', S)
    exited.reconcileEndedProcessForPaneKeys([PANE])
    expect(exited.getConversationIdentityForPane(PANE)).toBeUndefined()
  })

  it('keeps the facet on the remnant when the agent exits and the pane survives', () => {
    clock(1_700_000_000_000)
    const server = store()
    report(server, 'working', S, { model: 'P' })
    const kept = facet(server)
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    expect(server.getConversationIdentityForPane(PANE)).toEqual({
      facet: kept,
      rowAgent: 'claude',
      rowIsRemnant: true
    })
  })

  it('loses the facet when the row is dismissed inside the done -> working window (T7)', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'done', S)
    time.tick()
    osc(server, 'working')
    const snapshotBefore = server.getStatusSnapshot()
    server.dropStatusEntry(PANE)
    expect(server.getConversationIdentityForPane(PANE)).toBeUndefined()
    expect(snapshotBefore[0]?.providerSession).toBeUndefined()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it("replaces the facet with another agent's kept report; its status-only writes leave it", () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    report(server, 'done', S, {}, 'codex')
    const codexFacet = facet(server)
    time.tick()
    osc(server, 'working', 'claude')
    expect(facet(server)).toBe(codexFacet)
    expect(server.getConversationIdentityForPane(PANE)?.rowAgent).toBe('claude')
    time.tick()
    report(server, 'working', C, {}, 'claude')
    expect(facet(server)).toMatchObject({ agentType: 'claude', providerSession: C })
  })
})

describe('legacy outputs never carry the facet', () => {
  it('keeps conversation out of the snapshot, the pane rows and every emitted event', () => {
    const time = clock(1_700_000_000_000)
    const server = store()
    const emitted: unknown[] = []
    server.setListener((payload) => emitted.push(payload))
    report(server, 'working', S, { model: 'P' })
    time.tick()
    report(server, 'working', S, { model: 'Q' })
    time.tick()
    osc(server, 'done')
    for (const row of [...server.getStatusSnapshot(), ...server.getStatusSnapshotForPane(PANE)]) {
      expect(row).not.toHaveProperty('conversation')
    }
    // Why: listeners spread the row field by field; the census found no wire spread of the row.
    expect(emitted.length).toBeGreaterThan(0)
  })
})

describe('persistence', () => {
  it('round-trips the facet, reads a null or malformed one as absent and seeds every such row', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-conversation-facet-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    cleanups.push(() => first.stop())
    const response = await postHookEvent(
      first,
      buildBody({ hook_event_name: 'Stop', session_id: 'S', transcript_path: '/r/S.jsonl' }),
      '/hook/claude'
    )
    expect(response.status).toBe(204)
    const persisted = first.getConversationIdentityForPane(PANE)
    expect(persisted?.facet).toMatchObject({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'S', transcriptPath: '/r/S.jsonl' }
    })
    first.flushStatusPersistSync()
    const filePath = first.lastStatusPath ?? ''
    first.stop()
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.entries[PANE].conversation).toEqual(persisted?.facet)

    const hydrate = async (entry: Record<string, unknown>) => {
      writeFileSync(filePath, JSON.stringify({ ...raw, entries: { [PANE]: entry } }))
      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      cleanups.push(() => server.stop())
      return server
    }
    const entry = raw.entries[PANE]
    const restored = await hydrate(entry)
    expect(restored.getConversationIdentityForPane(PANE)).toEqual(persisted)
    // A repaint with another status, then an identical original report, change nothing.
    restored.ingestTerminalStatus({
      paneKey: PANE,
      payload: { state: 'working', agentType: 'claude', prompt: '' }
    })
    const repainted = restored.getConversationIdentityForPane(PANE)?.facet
    expect(repainted).toEqual(persisted?.facet)
    const again = await postHookEvent(
      restored,
      buildBody({ hook_event_name: 'Stop', session_id: 'S', transcript_path: '/r/S.jsonl' }),
      '/hook/claude'
    )
    expect(again.status).toBe(204)
    expect(restored.getConversationIdentityForPane(PANE)?.facet).toBe(repainted)
    const seededFromRow = {
      facet: {
        agentType: 'claude',
        providerSession: entry.providerSession,
        capturedAt: entry.receivedAt
      },
      rowAgent: 'claude',
      rowIsRemnant: false
    }
    const { conversation: _conversation, ...legacy } = entry
    // Why: a facet this version rejects (corrupt, or written by a newer version) is no clear.
    for (const conversation of [
      null,
      { agentType: 'claude' },
      { ...entry.conversation, modelSwitchCommand: 'orca-model-v2' }
    ]) {
      const hydrated = await hydrate({ ...entry, conversation })
      expect(hydrated.getConversationIdentityForPane(PANE)).toEqual(seededFromRow)
      hydrated.flushStatusPersistSync()
      expect(JSON.parse(readFileSync(filePath, 'utf8')).entries[PANE].conversation).toEqual(
        seededFromRow.facet
      )
      hydrated.stop()
    }
    expect((await hydrate(legacy)).getConversationIdentityForPane(PANE)).toEqual(seededFromRow)
    const aged = { ...entry, receivedAt: 1, stateStartedAt: 1 }
    expect((await hydrate(aged)).getConversationIdentityForPane(PANE)).toBeUndefined()
  })
})
