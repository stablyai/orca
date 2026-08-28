import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  observedIdentityFromAgentStatus,
  readPretoolDecision,
  readSafeLaunchAdmission,
  recordPretoolDecision,
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

  it('NEGATIVE: a PreTool event with no recorded decision is not an acceptance', () => {
    const dispatch = world()
    // A tool is visibly in flight on this Dispatch's own pane...
    const snapshot = [status({ toolName: 'Bash' })]
    expect(snapshot[0].toolName).toBe('Bash')
    // ...and that still decides nothing, because nothing recorded a decision.
    expect(readPretoolDecision(db!, dispatch.id)).toBeNull()
  })

  it('POSITIVE: an explicitly recorded acceptance is read back', () => {
    const dispatch = world()
    recordPretoolDecision(db!, {
      dispatchId: dispatch.id,
      decision: 'accepted',
      observedAt: new Date().toISOString()
    })
    expect(readPretoolDecision(db!, dispatch.id)).toBe('accepted')
  })

  it('records a denial as a denial, never as an absence', () => {
    const dispatch = world()
    recordPretoolDecision(db!, {
      dispatchId: dispatch.id,
      decision: 'denied',
      observedAt: new Date().toISOString()
    })
    expect(readPretoolDecision(db!, dispatch.id)).toBe('denied')
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
    expect(observedIdentityFromAgentStatus(dispatch, [status()], 'high')).toEqual({
      agent: 'claude',
      model: 'claude-opus-5',
      reasoning: 'high'
    })
  })

  it('NEGATIVE: a report from ANOTHER launch in the same pane is not this session', () => {
    const dispatch = world()
    const other = status({ launchToken: 'a-different-launch' })
    expect(observedIdentityFromAgentStatus(dispatch, [other], 'high')).toBeNull()
  })

  it('NEGATIVE: a report predating the Dispatch describes an earlier process', () => {
    const dispatch = world()
    const stale = status({ receivedAt: Date.parse('2000-01-01T00:00:00.000Z') })
    expect(observedIdentityFromAgentStatus(dispatch, [stale], 'high')).toBeNull()
  })

  it('NEGATIVE: a report from a different terminal or pane is not this session', () => {
    const dispatch = world()
    expect(
      observedIdentityFromAgentStatus(dispatch, [status({ paneKey: 'tab_other:leaf' })], 'high')
    ).toBeNull()
    expect(
      observedIdentityFromAgentStatus(dispatch, [status({ terminalHandle: 'term_other' })], 'high')
    ).toBeNull()
  })

  it('NEGATIVE: no provider-reported model means no observed identity', () => {
    const dispatch = world()
    expect(
      observedIdentityFromAgentStatus(dispatch, [status({ model: undefined })], 'high')
    ).toBeNull()
  })
})
