import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import type { SleepingAgentLaunchConfig } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { resolveAgentLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command'
import { recordWorkerResumeSession } from '../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { parseStartOptions } from '../../methods/orchestration/worker/follow-up/worker-earlier-work'
import { reopenedTerminalLaunchReceipt } from '../../methods/orchestration/worker/follow-up/worker-follow-up-launch'
import { parseRecordedWorkerLaunchOptions } from '../../methods/orchestration/worker/start/launch/worker-launch-preferences'
import {
  createWorkerReleaseFixture,
  workerIncarnation,
  workerPaneKey,
  type WorkerReleaseFixture
} from '../../methods/orchestration/worker/release/worker-release.test-fixture'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness,
  WORKSPACE_X
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: object | null } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const git = {
  path: '/work/tree-x',
  head: 'abc',
  branch: 'main',
  isBare: false,
  isMainWorktree: false
}
const worktree = {
  ...git,
  git,
  id: WORKSPACE_X,
  repoId: 'repo_1',
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  displayName: 'Worker workspace',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
const processIncarnation = structuredWorkerProcessIncarnation(SESSION_Y)
const hostScope = JSON.stringify({ kind: 'local', hostId: 'local' })

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object record, got ${JSON.stringify(value)}`)
  }
  return Object.fromEntries(Object.entries(value))
}

function readStartOptions(showResult: Record<string, unknown>): unknown {
  const worker = showResult.worker
  if (typeof worker !== 'object' || worker === null || !('startOptions' in worker)) {
    throw new Error(`expected worker.startOptions in ${JSON.stringify(showResult)}`)
  }
  return worker.startOptions
}

function setupStructuredHarness(options: {
  visibleInitially?: boolean
  sessionOptions?: Record<string, string>
}) {
  const visible = new Set<string>(options.visibleInitially ? [SESSION_X, SESSION_Y] : [SESSION_X])
  const h = createSessionCallerHarness(hostRef, () => ({ present: true, sessionIds: [...visible] }))
  const setSessionOptions = (next: Record<string, string> | undefined) => {
    const base = sessionRecord(
      SESSION_Y,
      options.visibleInitially
        ? {}
        : { lease: { claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null } }
    )
    h.records.set(SESSION_Y, { ...base, provider: 'claude', ...(next ? { options: next } : {}) })
  }
  setSessionOptions(options.sessionOptions)
  let sendMode: 'sent' | 'queued' = 'sent'
  let onBeforeSend: ((sessionId: string) => void) | undefined
  const surfaces: Pick<
    StructuredAgentSessionHost,
    'isSessionTabVisible' | 'revealSession' | 'send'
  > = {
    isSessionTabVisible: (sessionId) => visible.has(sessionId),
    revealSession: async (sessionId) => ({
      sessionId,
      workspaceId: WORKSPACE_X,
      agent: 'claude',
      readable: true
    }),
    send: async (_caller, request) => {
      onBeforeSend?.(request.envelope.sessionId)
      const id = request.envelope.clientOperationId
      if (sendMode === 'queued') {
        return {
          ok: true,
          replayed: false,
          fence: 7,
          cursor: { epoch: 'test', sequence: 1 },
          value: { clientMessageId: id, queued: { messageId: id, position: 1, state: 'waiting' } }
        }
      }
      return {
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'test', sequence: 1 },
        value: {
          clientMessageId: id,
          submission: {
            clientMessageId: id,
            fence: 7,
            payloadFingerprint: '',
            dispatchState: 'accepted',
            providerItemId: 'item_1',
            reason: null,
            submittedAt: 1,
            resolvedAt: 2,
            options: { ...h.records.get(request.envelope.sessionId)?.options }
          }
        }
      }
    }
  }
  Object.assign(
    hostRef.current!,
    {
      captureAgentStartDestination: () => null,
      hasSession: (sessionId: string) => h.records.has(sessionId),
      reads: { agentStarting: () => false }
    },
    surfaces
  )
  vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(worktree)
  vi.spyOn(h.runtime, 'validateOrchestrationAgentLauncher').mockReturnValue()
  vi.spyOn(h.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
    supported: true
  })
  vi.spyOn(h.runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
    visible.add(input.sessionId)
  })
  return {
    h,
    handle: mintStructuredWorkerHandle(),
    setSessionOptions,
    setSendMode: (mode: 'sent' | 'queued') => {
      sendMode = mode
    },
    setOnBeforeSend: (hook: ((sessionId: string) => void) | undefined) => {
      onBeforeSend = hook
    }
  }
}

async function createRunAndSettledStructuredWorker(
  h: SessionCallerHarness,
  handle: string,
  startOptions: Record<string, unknown>
) {
  const runId = idOf(
    resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { from: ADDRESS_X, objective: 'Follow-up dispatch settings' },
          { sessionId: SESSION_X }
        )
      )
    ).run
  )
  const { dispatch, task } = h.db.createStartingWorkerDispatch({
    taskSpec: 'Original work',
    taskRunId: runId,
    creator: { kind: 'session', orcaSessionId: SESSION_X },
    maxDepth: 3,
    startOptions,
    runtimeEpoch: h.runtime.getRuntimeId()
  })
  h.db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey,
    processIncarnation,
    hostScope,
    worktreeId: WORKSPACE_X,
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  h.db.markWorkerDispatchReady(dispatch.id, [])
  h.db.settleWorkerReport({
    taskId: task.id,
    dispatchId: dispatch.id,
    outcome: 'succeeded',
    result: 'Done'
  })
  return { runId, dispatchId: dispatch.id, taskId: task.id }
}

async function structuredSendAndShow(
  h: SessionCallerHarness,
  toDispatchId: string,
  subject: string
) {
  const receipt = resultOf(
    await h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        { from: ADDRESS_X, to: `dispatch:${toDispatchId}`, subject, body: subject },
        { sessionId: SESSION_X }
      )
    )
  )
  const shown = resultOf(
    await h.dispatch(
      orchestrationRequest(
        'orchestration.workerShow',
        { dispatch: String(receipt.dispatchId) },
        { sessionId: SESSION_X }
      )
    )
  )
  return { receipt, shown }
}

async function terminalSendAndShow(
  fixture: WorkerReleaseFixture,
  toDispatchId: string,
  subject: string
) {
  const receipt = asRecord(
    await fixture.call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${toDispatchId}`,
      subject,
      body: subject
    })
  )
  const shown = asRecord(
    await fixture.call('orchestration.workerShow', { dispatch: String(receipt.dispatchId) })
  )
  return { receipt, shown }
}

describe('follow-up dispatch effective settings (#49307)', () => {
  let structuredHarness: SessionCallerHarness | null = null
  let releaseDb: WorkerReleaseFixture['db'] | null = null

  afterEach(async () => {
    await Promise.resolve()
    structuredHarness?.close()
    structuredHarness = null
    releaseDb?.close()
    releaseDb = null
    vi.restoreAllMocks()
  })

  it('1. reopened retained structured chat records admission options with session source', async () => {
    const setup = setupStructuredHarness({
      visibleInitially: false,
      sessionOptions: { model: 'claude-sonnet-4-5', effort: 'medium' }
    })
    structuredHarness = setup.h
    const original = await createRunAndSettledStructuredWorker(setup.h, setup.handle, {
      agent: 'claude',
      launch: { requested: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' } }
    })

    const { receipt, shown } = await structuredSendAndShow(
      setup.h,
      original.dispatchId,
      'Closed chat'
    )
    expect(receipt).toMatchObject({ delivery: 'reopened', followUpOf: original.dispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' },
        effectiveSource: { agent: 'session', model: 'session', effort: 'session' }
      }
    })
  })

  it('2. open retained structured chat records admission options with session source', async () => {
    const setup = setupStructuredHarness({
      visibleInitially: true,
      sessionOptions: { model: 'claude-sonnet-4-5', effort: 'medium' }
    })
    structuredHarness = setup.h
    const original = await createRunAndSettledStructuredWorker(setup.h, setup.handle, {
      agent: 'claude',
      launch: { requested: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' } }
    })

    const { receipt, shown } = await structuredSendAndShow(
      setup.h,
      original.dispatchId,
      'Open chat'
    )
    expect(receipt).toMatchObject({ delivery: 'follow_up', followUpOf: original.dispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' },
        effectiveSource: { agent: 'session', model: 'session', effort: 'session' }
      }
    })
  })

  it('3. structured chat uses send-admission snapshot across race, empty options, and queued delivery', async () => {
    const setup = setupStructuredHarness({
      visibleInitially: true,
      sessionOptions: { model: 'claude-sonnet-4-5', effort: 'medium' }
    })
    structuredHarness = setup.h
    const original = await createRunAndSettledStructuredWorker(setup.h, setup.handle, {
      agent: 'claude',
      launch: { requested: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' } }
    })

    // Race: option changes AFTER dispatch creation / placement, right before send admission captures options.
    setup.setOnBeforeSend(() => {
      setup.setSessionOptions({ model: 'claude-opus-4-5', effort: 'high' })
    })
    const turn2 = await structuredSendAndShow(setup.h, original.dispatchId, 'Turn 2 race')
    setup.setOnBeforeSend(undefined)
    expect(readStartOptions(turn2.shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: 'claude-opus-4-5', effort: 'high' },
        effectiveSource: { agent: 'session', model: 'session', effort: 'session' }
      }
    })

    // Empty submission.options proves admission sent no pinned options -> deterministic default.
    setup.h.db.settleWorkerReport({
      taskId: String(turn2.receipt.taskId),
      dispatchId: String(turn2.receipt.dispatchId),
      outcome: 'succeeded',
      result: 'Done turn 2'
    })
    setup.setSessionOptions(undefined)
    const turn3 = await structuredSendAndShow(
      setup.h,
      String(turn2.receipt.dispatchId),
      'Turn 3 default'
    )
    expect(readStartOptions(turn3.shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'default', effort: 'default' }
      }
    })

    // Queued send carries no captured options snapshot -> unavailable.
    setup.h.db.settleWorkerReport({
      taskId: String(turn3.receipt.taskId),
      dispatchId: String(turn3.receipt.dispatchId),
      outcome: 'succeeded',
      result: 'Done turn 3'
    })
    setup.setSendMode('queued')
    const turn4 = await structuredSendAndShow(
      setup.h,
      String(turn3.receipt.dispatchId),
      'Turn 4 queued'
    )
    expect(readStartOptions(turn4.shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
      }
    })
  })

  it('4. started_fresh prefers launch.effective over differing launch.requested while retry stays unchanged', async () => {
    const fixture = createWorkerReleaseFixture()
    releaseDb = fixture.db
    const task = fixture.db.createTask({
      spec: 'Differing effective vs requested',
      runId: fixture.activeRunId
    })
    const started = asRecord(
      await fixture.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        model: 'gpt-5.2-codex',
        effort: 'high'
      })
    )
    const startedDispatchId = String(started.dispatchId)
    const differingRaw = JSON.stringify({
      agent: 'claude',
      launch: {
        requested: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'low' },
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' }
      }
    })
    expect(parseRecordedWorkerLaunchOptions(differingRaw)).toEqual({
      agent: 'claude',
      requestedAgent: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'low'
    })
    expect(parseStartOptions(differingRaw)).toEqual({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high'
    })
    fixture.db.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(differingRaw, startedDispatchId)
    fixture.db.settleWorkerReport({
      taskId: String(started.taskId),
      dispatchId: startedDispatchId,
      outcome: 'succeeded',
      result: 'Done'
    })
    await fixture.call('orchestration.workerRelease', { dispatch: startedDispatchId })

    const { receipt, shown } = await terminalSendAndShow(
      fixture,
      startedDispatchId,
      'Fresh follow-up'
    )
    expect(receipt).toMatchObject({ delivery: 'started_fresh', followUpOf: startedDispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
        effectiveSource: { agent: 'inherited', model: 'inherited', effort: 'inherited' }
      }
    })
  })

  it('5. open terminal follow-up records agent from session and marks model/effort unavailable', async () => {
    const fixture = createWorkerReleaseFixture()
    releaseDb = fixture.db
    vi.spyOn(fixture.runtime.orchestrationSenderNames, 'liveAgentOf').mockReturnValue('codex')
    const task = fixture.db.createTask({ spec: 'Open terminal worker', runId: fixture.activeRunId })
    const started = asRecord(
      await fixture.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        model: 'gpt-5.2-codex',
        effort: 'high'
      })
    )
    const startedDispatchId = String(started.dispatchId)
    fixture.db.settleWorkerReport({
      taskId: String(started.taskId),
      dispatchId: startedDispatchId,
      outcome: 'succeeded',
      result: 'Done'
    })

    const { receipt, shown } = await terminalSendAndShow(
      fixture,
      startedDispatchId,
      'Open terminal'
    )
    expect(receipt).toMatchObject({ delivery: 'follow_up', followUpOf: startedDispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'codex', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
      }
    })
  })

  it('6. legacy start_options and unknown effectiveSource values remain readable without dropping records', async () => {
    const unknownSourceRaw = JSON.stringify({
      agent: 'claude',
      launch: {
        requested: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium' },
        effective: { agent: 'claude', model: null, effort: 'high' },
        effectiveSource: { agent: 'future_source', model: 'future_source', effort: 'session' }
      }
    })
    expect(parseStartOptions(unknownSourceRaw)).toEqual({
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high'
    })

    const fixture = createWorkerReleaseFixture()
    releaseDb = fixture.db
    const task = fixture.db.createTask({ spec: 'Legacy record', runId: fixture.activeRunId })
    const started = asRecord(
      await fixture.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })
    )
    const startedDispatchId = String(started.dispatchId)
    fixture.db.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(
        JSON.stringify({
          agent: 'codex',
          launch: { requested: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'low' } }
        }),
        startedDispatchId
      )
    fixture.db.settleWorkerReport({
      taskId: String(started.taskId),
      dispatchId: startedDispatchId,
      outcome: 'succeeded',
      result: 'Done'
    })
    await fixture.call('orchestration.workerRelease', { dispatch: startedDispatchId })

    const { receipt, shown } = await terminalSendAndShow(
      fixture,
      startedDispatchId,
      'Legacy follow-up'
    )
    expect(receipt).toMatchObject({ delivery: 'started_fresh', followUpOf: startedDispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'low' },
        effectiveSource: { agent: 'inherited', model: 'inherited', effort: 'inherited' }
      }
    })
  })

  it('7. chat-assignee follow-up records admission snapshot (session, default on empty, unavailable on queued)', async () => {
    const setup = setupStructuredHarness({
      visibleInitially: true,
      sessionOptions: { model: 'claude-sonnet-4-5', effort: 'high' }
    })
    structuredHarness = setup.h
    const runId = idOf(
      resultOf(
        await setup.h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { from: ADDRESS_X, objective: 'Borrowed chat follow-up' },
            { sessionId: SESSION_X }
          )
        )
      ).run
    )
    const started = resultOf(
      await setup.h.dispatch(
        orchestrationRequest(
          'orchestration.workerStart',
          {
            from: ADDRESS_X,
            run: runId,
            spec: 'Borrowed chat',
            terminal: ADDRESS_Y,
            keepOpen: true
          },
          { sessionId: SESSION_X }
        )
      )
    )
    const dispatchId = String(started.dispatchId)
    setup.h.db.settleWorkerReport({
      taskId: String(started.taskId),
      dispatchId,
      outcome: 'succeeded',
      result: 'Done'
    })

    const turn2 = await structuredSendAndShow(setup.h, dispatchId, 'Borrowed turn 2')
    expect(turn2.receipt).toMatchObject({ delivery: 'follow_up', followUpOf: dispatchId })
    expect(readStartOptions(turn2.shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'high' },
        effectiveSource: { agent: 'session', model: 'session', effort: 'session' }
      }
    })

    setup.h.db.settleWorkerReport({
      taskId: String(turn2.receipt.taskId),
      dispatchId: String(turn2.receipt.dispatchId),
      outcome: 'succeeded',
      result: 'Done'
    })
    setup.setSendMode('queued')
    const turn3 = await structuredSendAndShow(
      setup.h,
      String(turn2.receipt.dispatchId),
      'Borrowed queued'
    )
    expect(readStartOptions(turn3.shown)).toMatchObject({
      launch: {
        effective: { agent: 'claude', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
      }
    })
  })

  function buildCodexRecipe(
    cmdOverrides: Partial<Record<'codex', string>>,
    agentArgs: string
  ): SleepingAgentLaunchConfig {
    const resolved = resolveAgentLaunchCommand({
      agent: 'codex',
      cmdOverrides,
      platform: 'darwin',
      shell: 'posix',
      agentArgs
    })
    if (!resolved.ok) {
      throw new Error(resolved.error)
    }
    return { agentArgs: '', ...resolved.resumeLaunch, agentEnv: {} }
  }

  async function setupSettledTerminalWorker(options: {
    sessionId: string
    launchConfig?: ReturnType<typeof buildCodexRecipe>
    model?: string
  }) {
    const fixture = createWorkerReleaseFixture()
    releaseDb = fixture.db
    const task = fixture.db.createTask({ spec: 'Terminal worker', runId: fixture.activeRunId })
    const started = asRecord(
      await fixture.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        model: options.model ?? 'old-model',
        effort: 'high'
      })
    )
    const dispatchId = String(started.dispatchId)
    const resource = fixture.db.getWorkerTerminalResourceByOwner(dispatchId)
    const providerSession = {
      key: 'session_id' as const,
      id: options.sessionId,
      transcriptPath: path.join(os.tmpdir(), `${options.sessionId}.jsonl`)
    }
    recordWorkerResumeSession(fixture.db, resource!.id, {
      paneKey: workerPaneKey,
      processIncarnation: workerIncarnation,
      connectionId: null,
      agent: 'codex',
      providerSession,
      ...(options.launchConfig ? { launchConfig: options.launchConfig } : {}),
      observedAt: 0
    })
    fixture.db.settleWorkerReport({
      taskId: String(started.taskId),
      dispatchId,
      outcome: 'succeeded',
      result: 'Done'
    })
    return { fixture, dispatchId, providerSession }
  }

  it('8. reopened TUI terminal parses standard agentCommand resume recipe via resolveAgentLaunchCommand and marks wrappers or missing fields unavailable', async () => {
    const reopenedConfig = buildCodexRecipe({}, '--model new-model --yolo')
    const { fixture, dispatchId } = await setupSettledTerminalWorker({
      sessionId: 'thread-reopen-1',
      launchConfig: reopenedConfig
    })
    vi.spyOn(fixture.runtime, 'isTerminalRunningAgent').mockResolvedValue(false)
    const resumeSpy = vi.spyOn(fixture.runtime, 'resumeAgentSessionInWorkspace').mockResolvedValue({
      ok: true,
      handle: 'term_resumed',
      paneKey: 'tab_resumed:11111111-1111-4111-8111-111111111111',
      ptyId: 'pty_resumed'
    })

    const { receipt, shown } = await terminalSendAndShow(fixture, dispatchId, 'Reopen TUI')
    expect(receipt).toMatchObject({ delivery: 'reopened', followUpOf: dispatchId })
    expect(resumeSpy).toHaveBeenCalledWith(
      'repo::worktree',
      expect.objectContaining({ launchConfig: reopenedConfig })
    )
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'codex', model: 'new-model', effort: null },
        effectiveSource: { agent: 'session', model: 'inherited', effort: 'unavailable' }
      }
    })

    const unavailable = {
      effective: { agent: 'codex', model: null, effort: null },
      effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
    } as const
    for (const entry of [
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({}, '--model new-model -c model_reasoning_effort=low'),
        effective: { agent: 'codex', model: 'new-model', effort: 'low' },
        effectiveSource: { agent: 'session', model: 'inherited', effort: 'inherited' }
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe(
          { codex: 'my-wrapper' },
          '--model wrapped-model -c model_reasoning_effort=high'
        ),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe(
          { codex: 'my-wrapper codex' },
          '--model wrapped-model -c model_reasoning_effort=high'
        ),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({ codex: 'codex --model $MODEL' }, ''),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({ codex: 'codex --model *' }, ''),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({}, '--model $MODEL -c model_reasoning_effort=$EFFORT'),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({}, '--model ? -c model_reasoning_effort=~user'),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({}, '--model [a-z] -c model_reasoning_effort=`id`'),
        ...unavailable
      },
      {
        hadLaunchConfig: true,
        recipe: buildCodexRecipe({ codex: 'codex --model gpt-{5,6}' }, ''),
        ...unavailable
      },
      { hadLaunchConfig: false, recipe: { agentArgs: '', agentEnv: {} }, ...unavailable }
    ] as const) {
      expect(
        reopenedTerminalLaunchReceipt('codex', entry.hadLaunchConfig, entry.recipe)
      ).toMatchObject({
        effective: entry.effective,
        effectiveSource: entry.effectiveSource
      })
    }
  })

  it('9. TUI reopen refused (no_resume_command) falls back to started_fresh without leaking prior recipe/options or writing null + default', async () => {
    const { fixture, dispatchId } = await setupSettledTerminalWorker({
      sessionId: 'thread-refused-1',
      launchConfig: { agentArgs: '--model old-model -c model_reasoning_effort=high', agentEnv: {} }
    })
    vi.spyOn(fixture.runtime, 'isTerminalRunningAgent').mockResolvedValue(false)
    vi.spyOn(fixture.runtime, 'resumeAgentSessionInWorkspace').mockResolvedValue({
      ok: false,
      reason: 'no_resume_command'
    })
    const createTerminalSpy = vi.spyOn(fixture.runtime, 'createTerminal')

    const { receipt, shown } = await terminalSendAndShow(fixture, dispatchId, 'Refused reopen')
    expect(receipt).toMatchObject({ delivery: 'started_fresh', followUpOf: dispatchId })
    expect(createTerminalSpy).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.not.objectContaining({ launchPreferences: expect.anything() })
    )
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        requested: { agent: 'codex', model: null, effort: null },
        effective: { agent: 'codex', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
      }
    })
  })

  it('10. userTab follow-up records agent from session and marks model/effort unavailable', async () => {
    const { fixture, dispatchId, providerSession } = await setupSettledTerminalWorker({
      sessionId: 'thread-user-1',
      model: 'gpt-5.2-codex'
    })
    vi.spyOn(fixture.runtime, 'isTerminalRunningAgent').mockImplementation(
      async (handle) => handle === 'term_user_tab'
    )
    vi.spyOn(fixture.runtime.orchestrationSenderNames, 'liveAgentOf').mockReturnValue('codex')
    vi.spyOn(fixture.runtime, 'getTerminalHandleForPaneKey').mockImplementation((key) =>
      key === 'tab_user:11111111-1111-4111-8111-111111111111' ? 'term_user_tab' : null
    )
    vi.spyOn(fixture.runtime, 'getAgentRowsForProviderSession').mockReturnValue([
      {
        state: 'waiting',
        prompt: '',
        receivedAt: 1,
        stateStartedAt: 1,
        agentType: 'codex',
        providerSession,
        paneKey: 'tab_user:11111111-1111-4111-8111-111111111111',
        connectionId: null
      }
    ])

    const { receipt, shown } = await terminalSendAndShow(fixture, dispatchId, 'User tab')
    expect(receipt).toMatchObject({ delivery: 'follow_up', followUpOf: dispatchId })
    expect(readStartOptions(shown)).toMatchObject({
      launch: {
        effective: { agent: 'codex', model: null, effort: null },
        effectiveSource: { agent: 'session', model: 'unavailable', effort: 'unavailable' }
      }
    })
  })
})
