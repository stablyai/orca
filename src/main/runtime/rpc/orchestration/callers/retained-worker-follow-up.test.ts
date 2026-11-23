import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
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

const worktree = {
  id: WORKSPACE_X,
  repoId: 'repo_1',
  path: '/work/tree-x',
  head: 'abc',
  branch: 'main',
  isBare: false,
  isMainWorktree: false,
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

describe('follow-up custody for a closed retained worker chat', () => {
  let h: SessionCallerHarness
  let runId: string
  let handle: string
  let owner: { id: string; task_id: string }
  let visible: Set<string>
  let observedCustody: unknown[]
  let deliveredTo: { sessionId: string; expectedRuntimeFence: number | null }[]

  function custodyRows(): unknown[] {
    return h.db.db
      .prepare(
        `SELECT id, owner_dispatch_id, prior_owner_dispatch_ids, ownership_state
           FROM worker_terminal_resources WHERE terminal_handle = ? ORDER BY id`
      )
      .all(handle)
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

  function send() {
    return h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        {
          from: ADDRESS_X,
          to: `dispatch:${owner.id}`,
          subject: 'Next work',
          body: 'Continue here'
        },
        { sessionId: SESSION_X }
      )
    )
  }

  beforeEach(async () => {
    visible = new Set([SESSION_X])
    observedCustody = []
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
        const { sessionId, expectedRuntimeFence, clientOperationId } = request.envelope
        deliveredTo.push({ sessionId, expectedRuntimeFence })
        observedCustody.push(custodyRows())
        return {
          ok: true,
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
      observedCustody.push(custodyRows())
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
    vi.restoreAllMocks()
  })

  it('moves the only owned row before publishing or delivering the same saved conversation', async () => {
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
    expect(deliveredTo).toEqual([{ sessionId: SESSION_Y, expectedRuntimeFence: 7 }])
    expect(h.db.getDispatchContextById(newOwner)).toMatchObject({
      assignee_handle: handle,
      assignee_orca_session_id: SESSION_Y,
      creator_orca_session_id: SESSION_X
    })
  })

  it.each([
    ['ambiguous custody', 'worker_identity_changed'],
    ['release in progress', 'terminal_release_in_progress'],
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
      } else if (scenario === 'release in progress') {
        const release = h.db.requestWorkerTerminalRelease(owner.id)
        expect(release.disposition).toBe('requested')
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
    expect(await send()).toMatchObject({
      ok: false,
      error: { code, data: { effectsApplied: false } }
    })
    expect(snapshot()).toEqual(before)
    expect(observedCustody).toEqual([])
  })
})
