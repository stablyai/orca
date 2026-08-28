import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  listPretoolReceipts,
  readPretoolVerdict,
  recordPretoolReceipt,
  type PretoolReceiptBinding
} from './pretool-receipt'

/** PRETOOL_ACCEPTANCE_IS_A_RECEIPT_OF_A_REAL_DECISION
 *
 *  Orca does not decide whether a tool may run — the existing SCL PreTool policy
 *  does, and duplicating it here would create a second security boundary free to
 *  drift from the first. Orca records what that decision WAS.
 *
 *  The danger in recording it is accepting something that merely correlates with
 *  a decision. Every control here is such a correlate being refused.
 */
describe('PRETOOL_ACCEPTANCE_IS_A_RECEIPT_OF_A_REAL_DECISION', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const BUILD = 'orca-1.4.178+abc+sha'
  const OTHER_BUILD = 'orca-1.4.178+def+other'

  function world() {
    db = new OrchestrationDb(':memory:')
    new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'work' })
    const a = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_a',
      assigneePaneKey: 'tab_a:leaf',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const other = db.createDispatchContext({
      taskId: db.createTask({ spec: 'other' }).id,
      assigneeHandle: 'term_b',
      assigneePaneKey: 'tab_b:leaf',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    return { a, other }
  }

  function binding(dispatchId: string, buildId = BUILD): PretoolReceiptBinding {
    return {
      dispatchId,
      runId: 'run_1',
      outcomeId: 'out_1',
      taskId: 'task_1',
      terminalHandle: 'term_a',
      paneKey: 'tab_a:leaf',
      processIncarnation: 'pty_1:inc_1',
      requestedRoute: { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'ultra' },
      effectiveRoute: { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'ultra' },
      buildId
    }
  }

  const claim = (decision: 'allow' | 'block', tool = 'Bash') => ({
    decision,
    policyId: 'scl.pre_tool_use_policy',
    policyVersion: '2026-08-28',
    toolName: tool,
    reason: decision === 'block' ? 'Direct git push is blocked.' : null
  })

  it('1. a real ALLOW gives this Dispatch valid PreTool acceptance', () => {
    const { a } = world()
    recordPretoolReceipt(db!, {
      binding: binding(a.id),
      claim: claim('allow'),
      observedAt: '2026-08-28T00:00:00.000Z'
    })
    expect(readPretoolVerdict(db!, { dispatchId: a.id, buildId: BUILD })).toBe('accepted')
  })

  it('2. a real BLOCK does not certify, and outranks an allow on the same Dispatch', () => {
    const { a } = world()
    recordPretoolReceipt(db!, {
      binding: binding(a.id),
      claim: claim('allow'),
      observedAt: '2026-08-28T00:00:00.000Z'
    })
    recordPretoolReceipt(db!, {
      binding: binding(a.id),
      claim: claim('block', 'Bash'),
      observedAt: '2026-08-28T00:00:01.000Z'
    })
    // If the real policy refused anything here, this route is not shown permitted.
    expect(readPretoolVerdict(db!, { dispatchId: a.id, buildId: BUILD })).toBe('denied')
  })

  it('3. a receipt earned by ANOTHER Dispatch does not carry over', () => {
    const { a, other } = world()
    recordPretoolReceipt(db!, {
      binding: binding(other.id),
      claim: claim('allow'),
      observedAt: '2026-08-28T00:00:00.000Z'
    })
    expect(readPretoolVerdict(db!, { dispatchId: other.id, buildId: BUILD })).toBe('accepted')
    expect(readPretoolVerdict(db!, { dispatchId: a.id, buildId: BUILD })).toBeNull()
  })

  it('4. a receipt earned under another runtime build is ignored', () => {
    const { a } = world()
    recordPretoolReceipt(db!, {
      binding: binding(a.id, OTHER_BUILD),
      claim: claim('allow'),
      observedAt: '2026-08-28T00:00:00.000Z'
    })
    // The receipt exists, and still proves nothing about the code running now.
    expect(listPretoolReceipts(db!, a.id)).toHaveLength(1)
    expect(readPretoolVerdict(db!, { dispatchId: a.id, buildId: BUILD })).toBeNull()
  })

  it('5. no receipt at all cannot produce acceptance, however the hook behaved', () => {
    const { a } = world()
    // A static fallback stdout, a PostToolUse event, a tool row, a launch token
    // and a healthy provider startup all leave this empty, because none of them
    // is a decision.
    expect(listPretoolReceipts(db!, a.id)).toEqual([])
    expect(readPretoolVerdict(db!, { dispatchId: a.id, buildId: BUILD })).toBeNull()
  })

  it('records which policy and version decided, so a receipt is auditable', () => {
    const { a } = world()
    recordPretoolReceipt(db!, {
      binding: binding(a.id),
      claim: claim('block'),
      observedAt: '2026-08-28T00:00:00.000Z'
    })
    expect(listPretoolReceipts(db!, a.id)[0]).toMatchObject({
      policy_id: 'scl.pre_tool_use_policy',
      policy_version: '2026-08-28',
      decision: 'block',
      tool_name: 'Bash',
      reason: 'Direct git push is blocked.'
    })
  })

  it('is idempotent for a replayed emit of the same decision', () => {
    const { a } = world()
    for (let i = 0; i < 3; i += 1) {
      recordPretoolReceipt(db!, {
        binding: binding(a.id),
        claim: claim('allow'),
        observedAt: '2026-08-28T00:00:00.000Z'
      })
    }
    expect(listPretoolReceipts(db!, a.id)).toHaveLength(1)
  })
})
