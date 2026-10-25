import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executeAgentLaunch } from './agent-launch-executor'
import {
  createRestTestRig,
  restTestSend,
  REST_TEST_CALLER as CALLER,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestOperationId,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createTestParams } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { agentLaunchSurfaceFactory } from '../runtime/rpc/methods/agent-launch-surfaces'
import { admitAgentLaunchOperation } from '../runtime/rpc/methods/agent-launch-replay'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RpcContext } from '../runtime/rpc/core'
import type { AgentLaunchIntent, AgentLaunchResult } from '../../shared/agent-launch-intent'
import {
  computeAgentLaunchFingerprint,
  deriveAgentLaunchChildOperationId
} from '../../shared/agent-launch-operation'
import type { StructuredAgentSessionFirstMessage } from '../../shared/structured-agent-session-create'
import { structuredAgentSessionCreateIntentFingerprint } from '../runtime/rpc/methods/structured-agent-session-create'
import {
  loadTestJournal,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import * as journalReducer from '../native-chat/agent-session-journal/journal-reducer'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { AgentLaunchWorkspaceFactory } from './agent-launch-surface-factories'
import {
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../native-chat/agent-session-journal/journal-subagent-item'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { AGENT_LAUNCH_METHODS } from '../runtime/rpc/methods/agent-launch'
import { runtimeStub } from '../runtime/rpc/methods/agent-launch.test-fixture'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import { layoutApplyOn } from '../runtime/session-layout-apply.test-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { HostFoundingAttempt } from './host-founding-attempt'
import { readPersistedTestAgentSessionStore } from '../runtime/agent-session-record-store-test-harness'

let rig: RestTestRig
let setup: ReturnType<typeof Promise.withResolvers<void>>
beforeEach(async () => {
  setup = Promise.withResolvers<void>()
  rig = await createRestTestRig({
    setupHold: () => setup.promise,
    idleSweep: { intervalMs: 60_000 }
  })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rig.host.close(SESSION, 'evict')
  setup.resolve()
  await rig.dispose()
})

function harness(
  prompt: AgentLaunchIntent['prompt'] | null = { delivery: 'submit', text: 'Implement A' }
) {
  const ancillaryEntered = Promise.withResolvers<void>()
  const ancillaryRelease = Promise.withResolvers<void>()
  const params = {
    agent: 'codex' as const,
    surface: 'chat' as const,
    sessionId: SESSION,
    sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
    target: { kind: 'create-worktree' as const, create: { repo: 'id:repo-1' } },
    ...(prompt ? { prompt } : {}),
    operationId: hostTestOperationId()
  }
  const intent: AgentLaunchIntent = params
  let session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const store = {
    getSettings: () => ({ experimentalNativeChat: true }),
    getRepos: () => [],
    getRepo: () => null,
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    applyLayoutCommand: layoutApplyOn(
      () => session,
      (next) => {
        session = next
      }
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real publication reads only the supplied layout/settings store methods.
  const realRuntime = new OrcaRuntimeService(store as never)
  const publish = realRuntime.publishStructuredAgentSessionTab.bind(realRuntime)
  const publishTab = vi
    .spyOn(realRuntime, 'publishStructuredAgentSessionTab')
    .mockImplementation(publish)
  const createTerminal = vi.fn(async () => {
    throw new Error('unexpected terminal')
  })
  const runtimeOverrides = {
    requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: true }) }),
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    ensureStructuredAgentSessionHost: async () => {},
    openAgentSessionRecordStore: async () => rig.store,
    resolveStructuredAgentSessionCreateIntent: async (input: { envelope: unknown }) => ({
      ...createTestParams(),
      envelope: input.envelope,
      options: { model: 'gpt-5.6-sol', effort: 'medium' }
    }),
    createTerminal
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only external runtime workspace/settings/publication seams are stubbed; admission, reservation, send and SQLite receipts below are real.
  const runtime = Object.assign(realRuntime, runtimeOverrides) as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the called adapters read runtime, clientKind and caller; subscription/transport members are never reached.
  const context = { runtime, caller: { kind: 'desktop' } } as RpcContext
  const fingerprint = computeAgentLaunchFingerprint(params)
  const child = deriveAgentLaunchChildOperationId(params.operationId)
  if (!child) {
    throw new Error('invalid test operation')
  }
  const recovery = vi.fn(async () => {})
  let ancillaryFailure: Error | undefined
  const createWorktree = vi.fn<AgentLaunchWorkspaceFactory['createWorktree']>(
    async ({ initializeSurface, onWorkspaceCreated }) => {
      onWorkspaceCreated?.('workspace-1')
      await initializeSurface?.({
        worktreeId: 'workspace-1',
        workspacePath: '/task',
        startupTerminalHandle: undefined
      })
      ancillaryEntered.resolve()
      await ancillaryRelease.promise
      if (ancillaryFailure) {
        throw ancillaryFailure
      }
      return { worktreeId: 'workspace-1', workspacePath: '/task', startupTerminalHandle: undefined }
    }
  )
  let recorded: AgentLaunchResult | undefined
  let nestedCaller = ''
  let attempt: HostFoundingAttempt = {}
  const run = async () => {
    const admission = await admitAgentLaunchOperation(context, params, fingerprint, NOW)
    if (admission.decision === 'replay') {
      return admission.result
    }
    if (admission.decision !== 'execute') {
      throw new Error(admission.refusal.message)
    }
    nestedCaller = admission.callerKey
    const records: Promise<void>[] = []
    attempt = {}
    const result = await executeAgentLaunch({
      runtime,
      intent,
      hostFoundingAttempt: attempt,
      surfaces: agentLaunchSurfaceFactory(
        context,
        admission.attachOperationId,
        admission.callerKey
      ),
      workspaces: { createWorktree, createRecoveryShell: recovery },
      onSurfaceAdmitted: (surface) => {
        recorded = surface
        records.push(admission.record(surface))
      }
    })
    await Promise.all(records)
    await admission.settle(result)
    return result
  }
  return {
    run,
    ancillaryEntered,
    ancillaryRelease,
    publishTab,
    publish,
    runtime,
    topology: () => {
      const snapshot = runtime.mobileSessionTabsByWorktree.get('workspace-1')
      if (!snapshot) {
        throw new Error('ordinary topology missing')
      }
      return snapshot
    },
    attempt: () => attempt,
    recovery,
    createTerminal,
    createWorktree,
    failAncillary: (error: Error) => {
      ancillaryFailure = error
    },
    recorded: () => recorded,
    nested: (body: StructuredAgentSessionFirstMessage['body']) =>
      agentLaunchSurfaceFactory(context, child, nestedCaller).createStructuredSession({
        worktreeId: 'workspace-1',
        agent: 'codex',
        sessionId: SESSION,
        options: intent.sessionOptions,
        firstMessage: body
      }),
    fingerprint: (firstMessage: StructuredAgentSessionFirstMessage) =>
      structuredAgentSessionCreateIntentFingerprint({
        envelope: {
          sessionId: SESSION,
          clientOperationId: child,
          payloadFingerprint: '',
          expectedRuntimeFence: null
        },
        worktree: 'id:workspace-1',
        agent: 'codex',
        options: params.sessionOptions,
        firstMessage
      }),
    operation: () => rig.store.getOperationRow(nestedCaller, child)
  }
}

function userTexts(sessionId = SESSION) {
  return [...(loadTestJournal(rig.root, sessionId)?.state.items.values() ?? [])].flatMap((item) =>
    item.body.kind === 'message' && item.body.role === 'user'
      ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

it('admits the supplied opening input before another client sends during ancillary provisioning', async () => {
  const h = harness()
  h.publishTab.mockImplementation(async (input) => {
    expect(userTexts()).toEqual(['Implement A'])
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    await h.publish(input)
  })
  const launch = h.run()
  try {
    await h.ancillaryEntered.promise
    expect(h.recorded()?.prompt).toMatchObject({ outcome: 'journaled' })
    expect(await rig.host.send(CALLER, restTestSend('Actually implement B'))).toMatchObject({
      ok: true
    })
    h.ancillaryRelease.resolve()
    const result = await launch
    expect(result.prompt).toMatchObject({ outcome: 'journaled' })
    expect(userTexts()).toEqual(['Implement A', 'Actually implement B'])
    const messageId = result.prompt?.outcome === 'journaled' ? result.prompt.messageId : ''
    const saved = loadTestJournal(rig.root, SESSION)?.state.submissions.get(messageId)
    expect(saved).toMatchObject({
      clientMessageId: messageId,
      origin: 'client',
      source: { kind: 'user' }
    })
    expect(h.attempt().identity).toMatchObject({
      fingerprint: h.operation()?.fingerprint,
      priorRecord: false
    })
    expect(h.operation()?.fingerprint).toBe(
      h.fingerprint({ clientMessageId: messageId, body: hostTestMessage('Implement A') })
    )
    expect(await h.run()).toEqual(result)
    expect(h.createWorktree).toHaveBeenCalledOnce()
  } finally {
    h.ancillaryRelease.resolve()
    await launch.catch(() => undefined)
  }
})

it('keeps a usable blank chat after a proven precommit message refusal without recovery or terminal fallback', async () => {
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(
    `CREATE TRIGGER refuse_submission BEFORE INSERT ON journal_rows WHEN NEW.row_json LIKE '%"kind":"submission"%' BEGIN SELECT RAISE(ABORT, 'simulated append failure'); END`
  )
  const open = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const h = harness()
  h.ancillaryRelease.resolve()
  const result = await h.run()
  expect(result).toMatchObject({
    outcome: { kind: 'structured' },
    prompt: { outcome: 'not-delivered' }
  })
  expect(h.publishTab).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(SESSION)).not.toBeNull()
  expect(userTexts()).toEqual([])
  expect(h.recovery).not.toHaveBeenCalled()
  expect(h.createTerminal).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  db.exec('DROP TRIGGER refuse_submission')
  expect(await h.run()).toEqual(result)
  expect(h.createWorktree).toHaveBeenCalledOnce()
  await expect(h.nested(hostTestMessage('Implement A'))).rejects.toThrow(
    'agent_session_operation_unknown'
  )
  expect(open).toHaveBeenCalledOnce()
  const replacement = restTestSend('editable replacement')
  expect(await rig.host.send(CALLER, replacement)).toMatchObject({
    ok: true
  })
  expect(userTexts()).toEqual(['editable replacement'])
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('published chat journal missing')
  }
  await journal.appendItem(
    subagentJournalItemIdentity('live-child'),
    subagentJournalBody({
      type: 'subagent',
      id: 'live-child',
      label: 'Live task',
      state: 'working',
      groupId: 'live-turn'
    }),
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const beforeReplay = await rig.host.journalSnapshot(SESSION)
  const accepted = journal.submission(replacement.envelope.clientOperationId)?.acceptedSequence
  expect(accepted).toBeDefined()
  expect(journal.wroteBeforeOpen(accepted)).toBe(false)
  await expect(h.nested(hostTestMessage('Implement A'))).rejects.toThrow(
    'agent_session_operation_unknown'
  )
  expect(await rig.host.journalSnapshot(SESSION)).toEqual(beforeReplay)
  expect(journal.wroteBeforeOpen(accepted)).toBe(false)
})

it.each(['before-fold', 'after-fold'] as const)(
  'keeps committed proof truthful after %s and replays one opening row',
  async (failure) => {
    const apply = journalReducer.applyJournalRow
    let injected = false
    vi.spyOn(journalReducer, 'applyJournalRow').mockImplementation((state, row, savedAt) => {
      if (!injected && row.kind === 'submission') {
        injected = true
        if (failure === 'after-fold') {
          apply(state, row, savedAt)
        }
        throw new Error('simulated fold failure after COMMIT')
      }
      apply(state, row, savedAt)
    })
    const h = harness()
    h.ancillaryRelease.resolve()
    const result = await h.run()
    expect(injected).toBe(true)
    expect(result).toMatchObject({
      outcome: { kind: 'structured' },
      prompt: { outcome: 'journaled' }
    })
    expect(h.recorded()?.prompt).toEqual(result.prompt)
    expect(userTexts()).toEqual(['Implement A'])
    expect(h.publishTab).toHaveBeenCalledOnce()
    expect(h.recovery).not.toHaveBeenCalled()
    expect(h.createTerminal).not.toHaveBeenCalled()
    expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(1)
    const next = await rig.host.send(CALLER, restTestSend('next message'))
    expect(next, JSON.stringify(next)).toMatchObject({ ok: true })
    expect(userTexts()).toEqual(['Implement A', 'next message'])
    expect(await h.run()).toEqual(result)
    const nested = await h.nested(hostTestMessage('Implement A'))
    expect(nested.promptDisposal).toMatchObject({ outcome: 'journaled' })
    await expect(h.nested(hostTestMessage('changed opening'))).rejects.toThrow()
  }
)

it.each(['runtime', 'mobile'] as const)(
  'keeps fresh and replayed uncertain answers within the %s v2 caller vocabulary',
  async (clientKind) => {
    const sessionId = 'codex_hv5_negotiation'
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const db = openTestJournalHostDatabase(rig.root).db
    const exec = db.exec.bind(db)
    let injected = false
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      const submission =
        sql === 'COMMIT' &&
        db
          .prepare(
            `SELECT 1 FROM journal_rows WHERE session_id = ? AND row_json LIKE '%"kind":"submission"%' LIMIT 1`
          )
          .get(sessionId)
      const result = exec(sql)
      if (!injected && submission) {
        injected = true
        throw new Error('COMMIT completed but its return was lost')
      }
      return result
    })
    const publishTab = vi.fn(async () => {
      throw new Error('publication unavailable')
    })
    const externalRuntime = {
      ...runtimeStub(),
      getRuntimeId: () => 'runtime-1',
      openAgentSessionRecordStore: async () => rig.store,
      openedAgentSessionRecordStore: () => rig.store,
      resolveStructuredAgentSessionCreateIntent: async (input: { envelope: unknown }) => ({
        ...createTestParams(),
        envelope: input.envelope,
        options: { model: 'gpt-5.6-sol', effort: 'medium' }
      }),
      publishStructuredAgentSessionTab: publishTab,
      selectCreatedMobileSessionTabForClient: vi.fn(() => true)
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only external runtime seams are stubbed; the real handler, executor, founding, ledger and response mappings execute.
      runtime: externalRuntime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const params = {
      agent: 'codex',
      surface: 'chat',
      sessionId,
      sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
      target: { kind: 'existing', worktree: 'id:workspace-1' },
      prompt: { text: 'Implement A', delivery: 'submit' },
      operationId: hostTestOperationId()
    }
    const request = {
      id: 'request-1',
      authToken: 'test-token',
      method: 'agent.launchReplay',
      params
    }
    const options = {
      clientKind,
      clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY],
      ...(clientKind === 'mobile'
        ? { pairedDeviceId: 'device-1' }
        : { caller: { kind: 'desktop' as const }, clientId: 'desktop-renderer' })
    }
    try {
      const fresh = await dispatcher.dispatch(request, options)
      const replayed = await dispatcher.dispatch(request, options)
      expect(injected, JSON.stringify({ fresh, replayed })).toBe(true)
      expect(userTexts(sessionId)).toEqual(['Implement A'])
      expect(loadTestJournal(rig.root, sessionId)?.state.submissions.size).toBe(1)
      expect(publishTab).not.toHaveBeenCalled()
      expect.soft(fresh, JSON.stringify({ fresh, replayed })).toMatchObject({
        ok: false,
        error: { code: 'agent_session_operation_unknown' }
      })
      expect(replayed).toMatchObject({
        ok: false,
        error: { code: 'agent_session_operation_unknown' }
      })
      expect(externalRuntime.createTerminal).not.toHaveBeenCalled()
    } finally {
      await rig.host.close(sessionId, 'evict')
    }
  }
)

it('keeps a no-prompt host create at rest', async () => {
  const h = harness(null)
  h.ancillaryRelease.resolve()
  const result = await h.run()
  expect(result.prompt).toBeUndefined()
  expect(userTexts()).toEqual([])
  expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(h.createTerminal).not.toHaveBeenCalled()
})

it('retains strict client firstMessage refusal without the host launch opt-in', async () => {
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(
    `CREATE TRIGGER refuse_submission BEFORE INSERT ON journal_rows WHEN NEW.row_json LIKE '%"kind":"submission"%' BEGIN SELECT RAISE(ABORT, 'simulated append failure'); END`
  )
  const firstMessage = {
    clientMessageId: hostTestOperationId(),
    body: hostTestMessage('strict input')
  }
  const publishTab = vi.fn(async () => {})
  expect(
    await rig.host.create(CALLER, createTestParams(firstMessage), { firstMessage, publishTab })
  ).toMatchObject({ ok: false })
  expect(rig.store.getRecord(SESSION)).toBeNull()
  expect(publishTab).not.toHaveBeenCalled()
  expect(userTexts()).toEqual([])
})

it('isolates a throwing first-record listener after COMMIT without blank re-founding or repair', async () => {
  const listener = vi.fn(() => {
    expect(userTexts()).toEqual(['Implement A'])
    throw new Error('first-record observer failed after COMMIT')
  })
  rig.store.onFirstRecord(listener)
  const blank = vi.spyOn(rig.store.founding, 'commit')
  const open = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const h = harness()
  h.ancillaryRelease.resolve()
  const result = await h.run()
  expect(listener).toHaveBeenCalledOnce()
  expect(blank).not.toHaveBeenCalled()
  expect(open).toHaveBeenCalledOnce()
  expect(result.prompt).toMatchObject({ outcome: 'journaled' })
  const saved = await readPersistedTestAgentSessionStore(rig.root)
  expect(Object.values(saved.operations)).toContainEqual(h.operation())
  expect(h.operation()?.outcome).toMatchObject({ status: 'succeeded', sessionId: SESSION })
  expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(1)
  expect(await rig.host.send(CALLER, restTestSend('ordinary B'))).toMatchObject({ ok: true })
  expect(userTexts()).toEqual(['Implement A', 'ordinary B'])
  expect(h.recovery).not.toHaveBeenCalled()
  expect(h.createTerminal).not.toHaveBeenCalled()
  expect(await h.run()).toEqual(result)
})

it.each(['before fold'] as const)(
  'v8 proof: strict existing create disposes its new failed handle after %s and ordinary B opens saved A',
  async () => {
    const firstMessage = {
      clientMessageId: hostTestOperationId(),
      body: hostTestMessage('strict A')
    }
    const params = createTestParams(firstMessage)
    const close = vi.spyOn(AgentSessionJournal.prototype, 'close')
    const open = vi.spyOn(AgentSessionJournal.prototype, 'open')
    const publishTab = vi.fn(async () => {})
    const apply = journalReducer.applyJournalRow
    let injected = false
    vi.spyOn(journalReducer, 'applyJournalRow').mockImplementation((state, row, savedAt) => {
      if (!injected && row.kind === 'submission') {
        injected = true
        throw new Error('fold skipped after COMMIT')
      }
      apply(state, row, savedAt)
    })
    const created = await rig.host.create(CALLER, params, { firstMessage, publishTab })
    expect(created).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'journalWriteFailed' } }
    })
    expect(close).toHaveBeenCalledOnce()
    const failedHandle = close.mock.contexts[0]
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
    expect(publishTab).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    const saved = await readPersistedTestAgentSessionStore(rig.root)
    expect(saved.records[SESSION]).toBeDefined()
    expect(Object.values(saved.operations)).toContainEqual(
      expect.objectContaining({
        operationId: params.envelope.clientOperationId,
        fingerprint: params.envelope.payloadFingerprint,
        outcome: { status: 'succeeded', sessionId: SESSION }
      })
    )
    expect(userTexts()).toEqual(['strict A'])
    expect(await rig.host.send(CALLER, restTestSend('ordinary B'))).toMatchObject({ ok: true })
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal).not.toBe(failedHandle)
    expect(userTexts()).toEqual(['strict A', 'ordinary B'])
    expect(open).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('disposes a partial new fold, publishes the adopted tab before ancillary work, and opens saved A only for ordinary B', async () => {
  const apply = journalReducer.applyJournalRow
  let injected = false
  vi.spyOn(journalReducer, 'applyJournalRow').mockImplementation((state, row, savedAt) => {
    if (!injected && row.kind === 'submission') {
      injected = true
      vi.spyOn(state.items, 'set').mockImplementationOnce(() => {
        throw new Error('item installation failed after cursor and submission mutation')
      })
    }
    apply(state, row, savedAt)
  })
  const open = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const h = harness()
  const launch = h.run()
  await h.ancillaryEntered.promise
  expect(injected).toBe(true)
  expect(h.recorded()?.prompt).toMatchObject({ outcome: 'journaled' })
  expect(open).toHaveBeenCalledOnce()
  expect(h.operation()?.outcome).toMatchObject({ status: 'succeeded' })
  expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(1)
  expect(userTexts()).toEqual(['Implement A'])
  expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
  expect(h.attempt().publication).toMatchObject({ sessionId: SESSION })
  const topology = h.topology()
  expect(topology.tabs).toContainEqual(expect.objectContaining({ sessionId: SESSION }))
  expect(topology.activeTabId).toBe(`agent-session:${SESSION}`)
  // A real independent pick made while ancillary waits stays selected.
  h.runtime.projectStructuredAgentSessionTab({
    workspaceId: 'workspace-1',
    sessionId: 'other-chat',
    agent: 'codex',
    activate: true
  })
  h.ancillaryRelease.resolve()
  const result = await launch
  expect(result.prompt).toMatchObject({ outcome: 'journaled' })
  expect(h.topology().activeTabId).toBe('agent-session:other-chat')
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  const next = await rig.host.send(CALLER, restTestSend('ordinary B'))
  expect(next).toMatchObject({ ok: true })
  expect(userTexts()).toEqual(['Implement A', 'ordinary B'])
  const afterB = await rig.host.journalSnapshot(SESSION)
  expect
    .soft(afterB.items)
    .toContainEqual(expect.objectContaining({ body: hostTestMessage('Implement A') }))
  expect(h.recovery).not.toHaveBeenCalled()
  expect(h.createTerminal).not.toHaveBeenCalled()
})

it.each(['before installation', 'after installation'] as const)(
  'keeps admitted A and truthful caller error when publication fails %s',
  async (boundary) => {
    const h = harness()
    h.publishTab.mockImplementation(async (input) => {
      if (boundary === 'after installation') {
        const unsubscribe = h.runtime.onMobileSessionTabsChanged(() => {
          throw new Error('publication notification unavailable')
        })
        try {
          await h.publish(input)
        } finally {
          unsubscribe()
        }
        return
      }
      throw new Error('publication before installation unavailable')
    })
    const launch = h.run()
    const rejected = expect(launch).rejects.toThrow('agent_session_operation_unknown')
    await h.ancillaryEntered.promise
    expect(userTexts()).toEqual(['Implement A'])
    expect(h.recorded()?.prompt).toMatchObject({ outcome: 'journaled' })
    expect(h.attempt().publication !== undefined).toBe(boundary === 'after installation')
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(true)
    h.ancillaryRelease.resolve()
    await rejected
    expect(h.createWorktree).toHaveBeenCalledOnce()
    expect(h.recovery).not.toHaveBeenCalled()
    expect(h.createTerminal).not.toHaveBeenCalled()
    expect((await h.run()).prompt).toMatchObject({ outcome: 'journaled' })
    expect(await rig.host.send(CALLER, restTestSend('ordinary B'))).toMatchObject({ ok: true })
    expect(userTexts()).toEqual(['Implement A', 'ordinary B'])
  }
)

it('keeps an unresolved COMMIT owned through one void initialization and ordinary ancillary provisioning', async () => {
  const db = openTestJournalHostDatabase(rig.root).db
  const exec = db.exec.bind(db)
  let lost = false
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    const submission =
      sql === 'COMMIT' &&
      db
        .prepare(
          `SELECT 1 FROM journal_rows WHERE session_id = ? AND row_json LIKE '%"kind":"submission"%' LIMIT 1`
        )
        .get(SESSION)
    const result = exec(sql)
    if (!lost && submission) {
      lost = true
      throw new Error('COMMIT return unavailable')
    }
    return result
  })
  const h = harness()
  const launch = h.run()
  const rejected = expect(launch).rejects.toThrow('agent_session_operation_unknown')
  await h.ancillaryEntered.promise
  expect(h.attempt().opening?.transaction.disposition).toBe('unresolved')
  expect(h.attempt().adopted).toBeUndefined()
  expect(h.recorded()).toBeUndefined()
  expect(userTexts()).toEqual(['Implement A'])
  expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
  expect(h.publishTab).not.toHaveBeenCalled()
  h.ancillaryRelease.resolve()
  await rejected
  expect(h.createWorktree).toHaveBeenCalledOnce()
  expect(h.createTerminal).not.toHaveBeenCalled()
  expect(h.recovery).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(1)
})

it('preserves accepted input and its recorded surface when ancillary provisioning substitutes a no-effects-looking error', async () => {
  const h = harness()
  const launch = h.run()
  const rejected = expect(launch).rejects.toThrow('Setup decision required')
  await h.ancillaryEntered.promise
  expect(h.recorded()?.prompt).toMatchObject({ outcome: 'journaled' })
  h.failAncillary(new Error('Setup decision required'))
  h.ancillaryRelease.resolve()
  await rejected
  expect(h.attempt().opening?.transaction.disposition).toBe('committed')
  expect(h.recovery).not.toHaveBeenCalled()
  expect(h.createTerminal).not.toHaveBeenCalled()
  expect((await h.run()).prompt).toMatchObject({ outcome: 'journaled' })
  expect(h.createWorktree).toHaveBeenCalledOnce()
  expect(userTexts()).toEqual(['Implement A'])
})
