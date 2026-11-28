import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { dispatchReportMailbox } from '../../../orchestration/workers/reports/dispatch-report-mailbox'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { observeWorkerWorking } from '../../../orchestration/workers/turn-stops/worker-working-observation'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
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
const SUCCESSOR = testOrcaSessionId('8c673b73-db35-4202-a1b7-9d9dacfd17fb')
const NATIVE_SESSION = testOrcaSessionId('2df381c4-5547-40d1-832e-f1ba372df683')
const NATIVE_ADDRESS = formatOrcaSessionAddress(NATIVE_SESSION)
const processIncarnation = structuredWorkerProcessIncarnation(SESSION_Y)
const hostScope = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('follow-up custody for retained worker chats', () => {
  let h: SessionCallerHarness
  let runId: string
  let handle: string
  let owner: { id: string; task_id: string }
  let visible: Set<string>
  let observedCustody: unknown[]
  let observedStages: unknown[]
  let deliveredTo: { sessionId: string; expectedRuntimeFence: number | null }[]
  let surfaces: Pick<StructuredAgentSessionHost, 'isSessionTabVisible' | 'revealSession' | 'send'>

  function custodyRows(): unknown[] {
    return h.db.db
      .prepare(
        `SELECT id, owner_dispatch_id, prior_owner_dispatch_ids, ownership_state
           FROM worker_terminal_resources WHERE terminal_handle = ? ORDER BY id`
      )
      .all(handle)
  }

  function recordCustody() {
    observedCustody.push(custodyRows())
    observedStages.push(
      h.db.db
        .prepare(
          `SELECT w.stage FROM worker_dispatches w JOIN worker_terminal_resources r
             ON r.owner_dispatch_id = w.dispatch_id WHERE r.terminal_handle = ?`
        )
        .get(handle)?.stage
    )
  }

  function settledWorker(withCustody = true) {
    const { dispatch } = h.db.createStartingWorkerDispatch({
      taskSpec: 'Earlier work',
      taskRunId: runId,
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: 3,
      startOptions: { agent: 'claude' },
      runtimeEpoch: h.runtime.getRuntimeId()
    })
    if (withCustody) {
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
    }
    h.db.failWorkerStart(dispatch.id, 'dispatch_input', 'Prior attempt ended')
    return dispatch
  }

  function send(body = 'Continue here') {
    return h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        {
          from: ADDRESS_X,
          to: `dispatch:${owner.id}`,
          subject: 'Next work',
          body
        },
        { sessionId: SESSION_X }
      )
    )
  }

  async function settledNativeChat() {
    h.records.set(NATIVE_SESSION, sessionRecord(NATIVE_SESSION))
    visible.add(NATIVE_SESSION)
    const queue = surfaces.send
    const submitAtOnce: StructuredAgentSessionHost['send'] = async (caller, request) => {
      const sent = await queue(caller, request)
      const clientMessageId = request.envelope.clientOperationId
      return sent.ok
        ? {
            ...sent,
            value: {
              clientMessageId,
              submission: {
                clientMessageId,
                fence: 7,
                payloadFingerprint: 'native-chat-task',
                dispatchState: 'accepted',
                providerItemId: 'native-turn',
                reason: null,
                submittedAt: 1,
                resolvedAt: 2
              }
            }
          }
        : sent
    }
    Object.assign(hostRef.current!, { send: submitAtOnce })
    const started = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.workerStart',
          {
            from: ADDRESS_X,
            run: runId,
            spec: 'Use the existing engineer chat',
            terminal: NATIVE_ADDRESS,
            keepOpen: true
          },
          { sessionId: SESSION_X }
        )
      )
    )
    const dispatchId = String(started.dispatchId)
    const taskId = String(started.taskId)
    expect(started).toMatchObject({ state: 'ready' })
    expect(h.db.getWorkerDispatch(dispatchId)).toMatchObject({ worktree_id: WORKSPACE_X })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      terminal_handle: NATIVE_ADDRESS,
      ownership_state: 'external'
    })
    resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          {
            from: NATIVE_ADDRESS,
            type: 'worker_done',
            subject: 'First work finished',
            payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
          },
          { sessionId: NATIVE_SESSION }
        )
      )
    )
    return { dispatchId, taskId }
  }

  beforeEach(async () => {
    visible = new Set([SESSION_X])
    observedCustody = []
    observedStages = []
    deliveredTo = []
    h = createSessionCallerHarness(hostRef, () => ({
      present: true,
      sessionIds: [...visible]
    }))
    h.records.set(
      SESSION_Y,
      sessionRecord(SESSION_Y, {
        lease: { claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null }
      })
    )
    surfaces = {
      isSessionTabVisible: (sessionId) => visible.has(sessionId),
      revealSession: async (sessionId) => ({
        sessionId,
        workspaceId: WORKSPACE_X,
        agent: 'claude',
        readable: true
      }),
      send: async (_caller, request) => {
        const { sessionId, expectedRuntimeFence, clientOperationId } = request.envelope
        deliveredTo.push({ sessionId, expectedRuntimeFence })
        recordCustody()
        return {
          ok: true,
          replayed: false,
          fence: 7,
          cursor: { epoch: 'test', sequence: 1 },
          value: {
            clientMessageId: clientOperationId,
            queued: { messageId: clientOperationId, position: 1, state: 'waiting' }
          }
        }
      }
    }
    Object.assign(hostRef.current!, { captureAgentStartDestination: () => null }, surfaces)
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(worktree)
    vi.spyOn(h.runtime, 'validateOrchestrationAgentLauncher').mockReturnValue()
    vi.spyOn(h.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(h.runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
      recordCustody()
      visible.add(input.sessionId)
    })
    runId = idOf(
      resultOf(
        await h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { from: ADDRESS_X, objective: 'Continue the saved worker' },
            { sessionId: SESSION_X }
          )
        )
      ).run
    )
    handle = mintStructuredWorkerHandle()
    owner = settledWorker()
  })

  afterEach(async () => {
    // The bot observer reads committed Dispatch rows in a microtask.
    await Promise.resolve()
    h.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('moves the only owned row before publishing or delivering the same saved conversation', async () => {
    h.records.get(SESSION_X)!.permissionMode = 'ask'
    h.records.get(SESSION_Y)!.permissionMode = 'full-access'
    const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)
    const receipt = resultOf(await send())
    expect(receipt).toMatchObject({ runId, delivery: 'reopened', followUpOf: owner.id })
    expect(receipt.taskId).not.toBe(owner.task_id)
    const newOwner = String(receipt.dispatchId)
    const expected = [
      {
        id: resource?.id,
        owner_dispatch_id: newOwner,
        prior_owner_dispatch_ids: JSON.stringify([owner.id]),
        ownership_state: 'owned'
      }
    ]
    expect(custodyRows()).toEqual(expected)
    expect(observedCustody).toEqual([expected, expected])
    expect(observedStages).toEqual(['retained_chat_before_brief', 'dispatch_input'])
    expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy(owner.id)?.id).toBe(resource?.id)
    expect(deliveredTo).toEqual([{ sessionId: SESSION_Y, expectedRuntimeFence: 7 }])
    expect(h.records.get(SESSION_Y)?.permissionMode).toBe('full-access')
    expect(h.db.getDispatchContextById(newOwner)).toMatchObject({
      assignee_handle: handle,
      assignee_orca_session_id: SESSION_Y,
      creator_orca_session_id: SESSION_X
    })
  })

  it('continues an existing native chat without taking ownership or creating a new chat', async () => {
    const { dispatchId, taskId } = await settledNativeChat()
    const continued = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          {
            from: ADDRESS_X,
            to: `dispatch:${dispatchId}`,
            subject: 'Review follow-up',
            body: 'Continue in the existing engineer chat'
          },
          { sessionId: SESSION_X }
        )
      )
    )
    expect(continued).toMatchObject({ delivery: 'follow_up', followUpOf: dispatchId })
    const successor = String(continued.dispatchId)
    expect(h.db.getDispatchContextById(dispatchId)).toMatchObject({ status: 'completed' })
    expect(h.db.getTask(taskId)).toMatchObject({ status: 'completed' })
    expect(h.db.getDispatchContextById(successor)).toMatchObject({
      status: 'dispatched',
      assignee_handle: NATIVE_ADDRESS,
      assignee_orca_session_id: NATIVE_SESSION,
      follow_up_of_dispatch_id: dispatchId
    })
    expect(h.db.getTask(String(continued.taskId))).toMatchObject({ status: 'dispatched' })
    expect(h.db.getWorkerDispatch(successor)).toMatchObject({
      state: 'ready',
      agent_terminal_handle: NATIVE_ADDRESS
    })
    resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          {
            from: NATIVE_ADDRESS,
            type: 'worker_done',
            subject: 'Follow-up finished',
            payload: JSON.stringify({
              taskId: continued.taskId,
              dispatchId: successor,
              outcome: 'succeeded'
            })
          },
          { sessionId: NATIVE_SESSION }
        )
      )
    )
    expect(h.db.getDispatchContextById(successor)).toMatchObject({ status: 'completed' })
    expect(h.db.getTask(String(continued.taskId))).toMatchObject({ status: 'completed' })
    const nativeResources = h.db.db
      .prepare(
        `SELECT owner_dispatch_id, ownership_state, auto_release_at
           FROM worker_terminal_resources WHERE terminal_handle = ? ORDER BY created_at, id`
      )
      .all(NATIVE_ADDRESS)
    expect(nativeResources).toHaveLength(2)
    expect(nativeResources).toEqual(
      expect.arrayContaining([
        {
          owner_dispatch_id: dispatchId,
          ownership_state: 'external',
          auto_release_at: null
        },
        {
          owner_dispatch_id: successor,
          ownership_state: 'external',
          auto_release_at: null
        }
      ])
    )
    expect(h.db.requestWorkerTerminalRelease(dispatchId)).toMatchObject({
      disposition: 'retained',
      reason: 'external_terminal'
    })
    expect(h.db.requestWorkerTerminalRelease(successor)).toMatchObject({
      disposition: 'retained',
      reason: 'external_terminal'
    })
    expect(deliveredTo.filter(({ sessionId }) => sessionId === NATIVE_SESSION)).toEqual([
      { sessionId: NATIVE_SESSION, expectedRuntimeFence: 7 },
      { sessionId: NATIVE_SESSION, expectedRuntimeFence: 7 }
    ])
  })

  it.each([
    {
      change: 'moved to another workspace',
      error: () => ({ code: 'terminal_worktree_mismatch' }),
      apply: () =>
        h.records.set(
          NATIVE_SESSION,
          sessionRecord(NATIVE_SESSION, { location: { workspaceId: 'other-workspace' } })
        )
    },
    {
      change: 'closed',
      error: (dispatchId: string) => ({
        code: 'runtime_error',
        message: expect.stringContaining(`Dispatch ${dispatchId} has no worker Orca started`)
      }),
      apply: () => visible.delete(NATIVE_SESSION)
    }
  ])('refuses a native chat $change before creating follow-up work', async ({ error, apply }) => {
    const { dispatchId } = await settledNativeChat()
    const before = [
      h.db.db.prepare('SELECT id, status FROM tasks ORDER BY id').all(),
      h.db.db.prepare('SELECT id, status FROM dispatch_contexts ORDER BY id').all(),
      h.db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all()
    ]
    apply()
    const refused = await h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        {
          from: ADDRESS_X,
          to: `dispatch:${dispatchId}`,
          subject: 'Follow up after the chat moved',
          body: 'Keep the original workspace'
        },
        { sessionId: SESSION_X }
      )
    )
    expect(refused).toMatchObject({ ok: false, error: error(dispatchId) })
    expect([
      h.db.db.prepare('SELECT id, status FROM tasks ORDER BY id').all(),
      h.db.db.prepare('SELECT id, status FROM dispatch_contexts ORDER BY id').all(),
      h.db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all()
    ]).toEqual(before)
    expect(deliveredTo.filter(({ sessionId }) => sessionId === NATIVE_SESSION)).toEqual([
      { sessionId: NATIVE_SESSION, expectedRuntimeFence: 7 }
    ])
  })

  it('reconciles a replacement history that ends in the outgoing owner', async () => {
    const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
    const rewrite = h.db.db.prepare(
      'UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?'
    )
    rewrite.run('["old-a","old-b"]', resource.id)
    const receipt = resultOf(await send())
    const successor = String(receipt.dispatchId)
    expect(h.db.getWorkerTerminalResourceByOwner(successor)?.prior_owner_dispatch_ids).toBe(
      JSON.stringify(['old-a', 'old-b', owner.id])
    )
    expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy('old-a')?.id).toBe(resource.id)
    h.db.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET owner_dispatch_id = ?, prior_owner_dispatch_ids = ? WHERE id = ?`
      )
      .run(owner.id, JSON.stringify(['replacement', 'old-b', owner.id, successor]), resource.id)
    expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy('old-a')).toBeUndefined()
    expect(h.db.getWorkerTerminalResourceFormerlyOwnedBy('replacement')?.id).toBe(resource.id)
  })

  it('continues a persisted lineage whose successor is already open', async () => {
    h.records.set(SESSION_Y, {
      ...h.records.get(SESSION_Y)!,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        operationId: 'persisted-clear',
        callerKey: 'fixture',
        replacementSessionId: SUCCESSOR
      }
    })
    h.records.set(SUCCESSOR, sessionRecord(SUCCESSOR))
    visible.add(SUCCESSOR)
    const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
    const result = resultOf(await send())
    expect(result).toMatchObject({ delivery: 'follow_up', followUpOf: owner.id })
    expect(custodyRows()).toEqual([
      {
        id: resource.id,
        owner_dispatch_id: result.dispatchId,
        prior_owner_dispatch_ids: JSON.stringify([owner.id]),
        ownership_state: 'owned'
      }
    ])
    expect(deliveredTo).toEqual([{ sessionId: SUCCESSOR, expectedRuntimeFence: 7 }])
  })

  it('reopens a retained chat retired during workspace lookup', async () => {
    const lookup = Promise.withResolvers<void>()
    const workspace = Promise.withResolvers<typeof worktree>()
    h.records.set(SESSION_Y, sessionRecord(SESSION_Y))
    visible.add(SESSION_Y)
    vi.mocked(h.runtime.showManagedTerminalWorkspace).mockImplementationOnce(() => {
      lookup.resolve()
      return workspace.promise
    })
    const pending = send()
    await lookup.promise
    visible.delete(SESSION_Y)
    h.records.set(
      SESSION_Y,
      sessionRecord(SESSION_Y, {
        lease: { claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null }
      })
    )
    workspace.resolve(worktree)
    const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
    const receipt = resultOf(await pending)
    expect(receipt).toMatchObject({ delivery: 'reopened', followUpOf: owner.id })
    expect(custodyRows()).toEqual([
      {
        id: resource.id,
        owner_dispatch_id: receipt.dispatchId,
        prior_owner_dispatch_ids: JSON.stringify([owner.id]),
        ownership_state: 'owned'
      }
    ])
    expect(deliveredTo).toEqual([{ sessionId: SESSION_Y, expectedRuntimeFence: 7 }])
  })

  it('reopens a closed external worker chat without claiming ownership', async () => {
    const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
    h.db.db
      .prepare(
        `UPDATE worker_terminal_resources
            SET ownership_state = 'external', release_state = 'retained',
                retained_reason = 'external_terminal'
          WHERE id = ?`
      )
      .run(resource.id)
    const first = resultOf(await send())
    expect(first).toMatchObject({ delivery: 'reopened', followUpOf: owner.id })
    const firstFollowUpId = String(first.dispatchId)
    expect(h.db.getWorkerTerminalResourceByOwner(firstFollowUpId)).toMatchObject({
      ownership_state: 'external',
      terminal_handle: handle
    })
    expect(
      h.db.settleWorkerReport({
        taskId: String(first.taskId),
        dispatchId: firstFollowUpId,
        outcome: 'succeeded',
        result: 'Done'
      })
    ).toMatchObject({ action: 'settled' })
    visible.delete(SESSION_Y)
    const second = resultOf(await send('Continue external again'))
    expect(second).toMatchObject({ delivery: 'reopened', followUpOf: firstFollowUpId })
    expect(custodyRows()).toEqual([
      expect.objectContaining({ ownership_state: 'external' }),
      expect.objectContaining({ ownership_state: 'external' }),
      expect.objectContaining({ ownership_state: 'external' })
    ])
    expect(
      deliveredTo
        .filter(({ sessionId }) => sessionId !== SESSION_X)
        .map(({ sessionId }) => sessionId)
    ).toEqual([SESSION_Y, SESSION_Y])
  })

  it('stores a competing send on the follow-up that published the tab first', async () => {
    const entered = Promise.withResolvers<void>()
    const workspace = Promise.withResolvers<typeof worktree>()
    vi.mocked(h.runtime.showManagedTerminalWorkspace)
      .mockResolvedValueOnce(worktree)
      .mockImplementationOnce(() => {
        entered.resolve()
        return workspace.promise
      })
    const competing = send('Steer the winner')
    await entered.promise
    const winner = resultOf(await send())
    const winningDispatchId = idOf({ id: winner.dispatchId })
    workspace.resolve(worktree)
    const steered = resultOf(await competing)
    expect(steered).toMatchObject({
      message: { to_handle: `dispatch:${winningDispatchId}`, body: 'Steer the winner' }
    })
    expect(custodyRows()).toHaveLength(1)
    expect(deliveredTo).toHaveLength(1)
  })

  it('continues after a requested release settles during the bounded wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const release = h.db.requestWorkerTerminalRelease(owner.id)
    if (release.disposition !== 'requested') {
      throw new Error('Expected the settled worker to have a release request')
    }
    const pending = send()
    await vi.advanceTimersByTimeAsync(0)
    expect(custodyRows()).toHaveLength(1)
    h.db.settleWorkerTerminalRelease(release.resource.id)
    await vi.advanceTimersByTimeAsync(250)
    const receipt = resultOf(await pending)
    expect(receipt).toMatchObject({ delivery: 'reopened', followUpOf: owner.id })
    expect(custodyRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: release.resource.id, ownership_state: 'released' }),
        expect.objectContaining({ owner_dispatch_id: receipt.dispatchId, ownership_state: 'owned' })
      ])
    )
  })

  it('refuses a matching explicit start even before that start attaches authority', async () => {
    const { dispatch } = h.db.createStartingWorkerDispatch({
      taskSpec: 'Competing explicit start',
      taskRunId: runId,
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: 3,
      startOptions: { terminal: handle },
      runtimeEpoch: h.runtime.getRuntimeId()
    })
    expect(await send()).toMatchObject({
      ok: false,
      error: { code: 'terminal_busy', data: { dispatchId: dispatch.id, effectsApplied: false } }
    })
    expect(h.db.getWorkerTerminalResourceByOwner(owner.id)).toBeDefined()
    expect(observedCustody).toEqual([])
  })

  it.each([
    ['retained_chat_before_brief', 'failed', 'failed', 'failed', 'before sending'],
    ['dispatch_input', 'start_unknown', 'pending', 'blocked', 'never saw']
  ] as const)(
    'recovers a restart at %s with one coordinator report',
    async (stage, workerState, dispatchState, taskState, wording) => {
      const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
      const { dispatch, task } = h.db.createStartingWorkerDispatch({
        taskSpec: 'Interrupted continuation',
        taskRunId: runId,
        creator: { kind: 'session', orcaSessionId: SESSION_X },
        maxDepth: 3,
        startOptions: {},
        runtimeEpoch: 'previous-runtime',
        followUpOf: owner.id,
        retainedChat: {
          authority: {
            resourceId: resource.id,
            ownerDispatchId: owner.id,
            handle,
            paneKey,
            processIncarnation,
            hostScope
          },
          effects: [],
          worktreeId: WORKSPACE_X
        }
      })
      expect(h.db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'starting',
        stage: 'retained_chat_before_brief',
        agent_terminal_handle: handle
      })
      if (stage === 'dispatch_input') {
        h.db.recordWorkerStage({ dispatchId: dispatch.id, stage })
      }
      await h.runtime.reportUnconfirmedWorkerStart(dispatch.id)
      await h.runtime.reportUnconfirmedWorkerStart(dispatch.id)
      expect(h.db.getWorkerDispatch(dispatch.id)).toMatchObject({ state: workerState, stage })
      expect(h.db.getDispatchContextById(dispatch.id)?.status).toBe(dispatchState)
      expect(h.db.getTask(task.id)?.status).toBe(taskState)
      expect(h.db.getWorkerTerminalResourceByOwner(dispatch.id)?.id).toBe(resource.id)
      const mailbox = dispatchReportMailbox(h.db, dispatch)
      expect(
        h.db.getAllMessagesForHandle(mailbox).filter((mail) => mail.payload?.includes(dispatch.id))
      ).toEqual([expect.objectContaining({ body: expect.stringContaining(wording) })])
      expect(deliveredTo).toEqual([])
    }
  )

  it.each(['starting', 'start_unknown'] as const)(
    'recovers a saved legacy %s chat without revoking authority',
    async (state) => {
      const { dispatch, task } = h.db.createStartingWorkerDispatch({
        taskSpec: 'Work from an older runtime',
        taskRunId: runId,
        creator: { kind: 'session', orcaSessionId: SESSION_X },
        maxDepth: 3,
        startOptions: {},
        runtimeEpoch: 'legacy-runtime'
      })
      const legacyHandle = mintStructuredWorkerHandle()
      h.db.prepareStartingWorkerAuthority({
        dispatchId: dispatch.id,
        handle: legacyHandle,
        paneKey: mintStructuredWorkerPaneKey(SUCCESSOR),
        processIncarnation: structuredWorkerProcessIncarnation(SUCCESSOR),
        hostScope,
        worktreeId: WORKSPACE_X,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      if (state === 'start_unknown') {
        h.db.markWorkerStartUnknown(dispatch.id, 'authority_attached', 'Interrupted legacy start')
      }
      const directory = mkdtempSync(join(tmpdir(), 'orca-legacy-worker-'))
      try {
        const path = join(directory, 'orchestration.db')
        await h.db.db.backup(path)
        const db = new OrchestrationDb(path)
        try {
          expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
            state,
            stage: 'authority_attached'
          })
          const runtime = new OrcaRuntimeService()
          runtime.setOrchestrationDb(db)
          await runtime.reportUnconfirmedWorkerStart(dispatch.id)
          await runtime.reportUnconfirmedWorkerStart(dispatch.id)
          expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('start_unknown')
          const pending = db.getDispatchContextById(dispatch.id)!
          expect(pending).toMatchObject({ status: 'pending', capability_revoked_at: null })
          expect(db.getTask(task.id)?.status).toBe('blocked')
          const mailbox = dispatchReportMailbox(db, pending)
          expect(
            db
              .getAllMessagesForHandle(mailbox)
              .filter((mail) => mail.payload?.includes(dispatch.id))
          ).toEqual([expect.objectContaining({ body: expect.stringContaining('never saw') })])
          observeWorkerWorking(db, { kind: 'local', dispatch: pending }, true)
          expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
          expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
          expect(db.getTask(task.id)?.status).toBe('dispatched')
        } finally {
          await Promise.resolve()
          db.close()
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([
    ['ambiguous custody', 'worker_identity_changed'],
    ['release in progress', 'terminal_busy'],
    ['unconfirmed release', 'terminal_busy'],
    ['user reopened the chat', 'worker_identity_changed'],
    ['owner changed', 'worker_identity_changed']
  ] as const)('refuses %s before accepting a Task or exposing the chat', async (scenario, code) => {
    const snapshot = () => [
      h.db.db.prepare('SELECT id, status FROM tasks ORDER BY id').all(),
      h.db.db.prepare('SELECT id, status FROM dispatch_contexts ORDER BY id').all(),
      h.db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all()
    ]
    let before: unknown
    vi.mocked(h.runtime.showManagedTerminalWorkspace).mockImplementationOnce(async () => {
      if (scenario === 'ambiguous custody') {
        settledWorker()
      } else if (scenario === 'release in progress' || scenario === 'unconfirmed release') {
        const release = h.db.requestWorkerTerminalRelease(owner.id)
        expect(release.disposition).toBe('requested')
        if (scenario === 'unconfirmed release' && release.disposition === 'requested') {
          h.db.markWorkerTerminalReleaseUnknown(release.resource.id, 'The close was not observed')
        }
      } else if (scenario === 'user reopened the chat') {
        visible.add(SESSION_Y)
      } else {
        const resource = h.db.getWorkerTerminalResourceByOwner(owner.id)!
        const replacement = settledWorker(false)
        h.db.transferWorkerTerminalResourceStatement({
          resourceId: resource.id,
          toDispatchId: replacement.id,
          terminalHandle: handle,
          paneKey,
          processIncarnation,
          hostScope
        })
      }
      before = snapshot()
      return worktree
    })
    const response = await send()
    expect(response).toMatchObject({
      ok: false,
      error: { code, data: { effectsApplied: false } }
    })
    if (scenario === 'release in progress') {
      expect(response).toMatchObject({
        error: { message: expect.stringContaining('release in progress') }
      })
    }
    expect(snapshot()).toEqual(before)
    expect(observedCustody).toEqual([])
  })
})
