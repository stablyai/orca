import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { readPretoolVerdict } from './pretool-receipt'
import {
  observedIdentityFromAgentStatus,
  readSafeLaunchAdmission,
  recordSafeLaunchAdmission
} from './route-runtime-events'

/** ROUTE_EVIDENCE_MUST_NOT_ACCEPT_A_PROXY
 *
 *  Three of the ten certification evidence kinds had no production writer, so no
 *  route could reach PASS. The writers exist now — and the danger in adding them
 *  is writing down something that merely CORRELATES with the fact instead of the
 *  fact. Each control below is a proxy that must not be accepted:
 *
 *    a PreTool hook event is not an acceptance decision;
 *    a launch token is not a safe-launch admission;
 *    a status report from another launch in the same pane is not this session.
 */
describe('ROUTE_EVIDENCE_MUST_NOT_ACCEPT_A_PROXY', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const TOKEN = 'launch-token-abc'
  const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

  function world() {
    db = new OrchestrationDb(':memory:')
    new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'claude',
        launch: {
          requested: { agent: 'claude', model: 'opus', effort: 'high' },
          effective: { agent: 'claude', model: 'opus', effort: 'high' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf',
      processIncarnation: 'pty_1:inc_1',
      launchTokenHash: TOKEN_HASH,
      worktreeId: 'repo::/wt',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return db.getDispatchContextById(started.dispatch.id)!
  }

  function status(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    return {
      paneKey: 'tab_worker:leaf',
      terminalHandle: 'term_worker',
      launchToken: TOKEN,
      connectionId: null,
      receivedAt: Date.now() + 60_000,
      stateStartedAt: Date.now(),
      state: 'working',
      agentType: 'claude',
      model: 'claude-opus-5',
      prompt: '',
      ...overrides
    } as AgentStatusIpcPayload
  }

  function exactStatus(
    dispatch: ReturnType<typeof world>,
    overrides: Partial<AgentStatusIpcPayload> = {}
  ): AgentStatusIpcPayload {
    return status({
      orchestration: {
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        processIncarnation: dispatch.process_incarnation as string,
        launchTokenHash: dispatch.launch_token_hash as string
      },
      ...overrides
    })
  }

  it('NEGATIVE: a PreTool event with no receipt is not an acceptance', () => {
    const dispatch = world()
    // A tool is visibly in flight on this Dispatch's own pane...
    const snapshot = [exactStatus(dispatch, { toolName: 'Bash' })]
    expect(snapshot[0].toolName).toBe('Bash')
    // ...and that still decides nothing, because no real decision was recorded.
    expect(readPretoolVerdict(db!, { dispatchId: dispatch.id, buildId: 'b1' })).toBeNull()
  })

  it('NEGATIVE: a launch token is not a safe-launch admission', () => {
    const dispatch = world()
    expect(dispatch.launch_token_hash).toBe(TOKEN_HASH)
    expect(readSafeLaunchAdmission(db!, dispatch.id)).toBeNull()
  })

  it('POSITIVE: an explicitly recorded admission is read back, and is single-writer', () => {
    const dispatch = world()
    const at = new Date().toISOString()
    recordSafeLaunchAdmission(db!, {
      dispatchId: dispatch.id,
      decision: 'admitted',
      observedAt: at
    })
    // A later write cannot flip a recorded decision.
    recordSafeLaunchAdmission(db!, { dispatchId: dispatch.id, decision: 'refused', observedAt: at })
    expect(readSafeLaunchAdmission(db!, dispatch.id)).toBe('admitted')
  })

  it('reads the provider-reported model for this exact session', () => {
    const dispatch = world()
    expect(observedIdentityFromAgentStatus(dispatch, [exactStatus(dispatch)], 'high')).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      reasoning: 'high'
    })
  })

  it('NEGATIVE: a report from ANOTHER launch in the same pane is not this session', () => {
    const dispatch = world()
    const other = exactStatus(dispatch, { launchToken: 'a-different-launch' })
    expect(observedIdentityFromAgentStatus(dispatch, [other], 'high')).toBeNull()
  })

  it('NEGATIVE: a report predating the Dispatch describes an earlier process', () => {
    const dispatch = world()
    const stale = exactStatus(dispatch, {
      receivedAt: Date.parse('2000-01-01T00:00:00.000Z')
    })
    expect(observedIdentityFromAgentStatus(dispatch, [stale], 'high')).toBeNull()
  })

  it('NEGATIVE: a report from a different terminal or pane is not this session', () => {
    const dispatch = world()
    expect(
      observedIdentityFromAgentStatus(
        dispatch,
        [exactStatus(dispatch, { paneKey: 'tab_other:leaf' })],
        'high'
      )
    ).toBeNull()
    expect(
      observedIdentityFromAgentStatus(
        dispatch,
        [exactStatus(dispatch, { terminalHandle: 'term_other' })],
        'high'
      )
    ).toBeNull()
  })

  it('NEGATIVE: no provider-reported model means no observed identity', () => {
    const dispatch = world()
    expect(
      observedIdentityFromAgentStatus(
        dispatch,
        [exactStatus(dispatch, { model: undefined })],
        'high'
      )
    ).toBeNull()
  })
})
