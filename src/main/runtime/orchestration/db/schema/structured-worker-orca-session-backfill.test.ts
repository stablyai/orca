import { afterEach, describe, expect, it } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { OrchestrationDb } from '../orchestration-db'
import { backfillStructuredWorkerOrcaSessionIds } from './structured-worker-orca-session-backfill'

const SESSION_A = '0d2f4b6a-8c1e-4a3b-9d5f-7e0a2c4b6d81'
const SESSION_B = '1e3a5c7b-9d2f-4b4c-8e6a-0f1b3d5c7e92'
const SESSION_C = '2f4b6d8c-0e3a-4c5d-9f7b-1a2c4e6d8fa3'
const UNCAPPED = Number.MAX_SAFE_INTEGER
const SYSTEM = { kind: 'system' } as const

describe('structured worker Orca session id backfill', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  function dispatch(params: {
    handle: string
    paneKey: string
    incarnation?: string
    creator?: { kind: 'terminal'; handle: string; paneKey: string }
  }): string {
    const task = db.createTask({ runId: 'run_legacy_local', spec: `work for ${params.handle}` })
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: params.handle,
      assigneePaneKey: params.paneKey,
      processIncarnation: params.incarnation,
      creator: params.creator ?? SYSTEM,
      maxDepth: UNCAPPED
    }).id
  }

  function orcaSessionIds(dispatchId: string): { assignee: string | null; creator: string | null } {
    const row = db.getDispatchContextById(dispatchId)
    return {
      assignee: row?.assignee_orca_session_id ?? null,
      creator: row?.creator_orca_session_id ?? null
    }
  }

  it('proves a handle through the session this host recorded against it', () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const pane = mintStructuredWorkerPaneKey(SESSION_B)
    // The worker's own row carries no incarnation; its terminal resource row does.
    const handleOnly = dispatch({ handle, paneKey: pane })
    db.createWorkerTerminalResourceStatement({
      dispatchId: handleOnly,
      worktreeId: 'wt_1',
      terminalHandle: handle,
      paneKey: pane,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_B),
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      ownership: 'owned'
    })

    backfillStructuredWorkerOrcaSessionIds(db.db)

    expect(orcaSessionIds(handleOnly)).toEqual({ assignee: SESSION_B, creator: null })
  })

  it('leaves every row it cannot tie to exactly one valid session NULL', () => {
    db = new OrchestrationDb(':memory:')
    const unrecorded = mintStructuredWorkerHandle()
    const noRecord = dispatch({
      handle: unrecorded,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A)
    })
    const invalidId = dispatch({
      handle: mintStructuredWorkerHandle(),
      paneKey: 'tab_x:44444444-4444-4444-8444-444444444444',
      incarnation: 'structured:not a session id'
    })
    // A terminal in a structured session's tab: the pane key names a session, the process does not.
    const terminalInSessionTab = dispatch({
      handle: 'term_tui',
      paneKey: mintStructuredWorkerPaneKey(SESSION_C),
      incarnation: 'pty_proc_1a2b:777'
    })
    const shared = mintStructuredWorkerHandle()
    const conflicting = dispatch({
      handle: shared,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A),
      incarnation: structuredWorkerProcessIncarnation(SESSION_A)
    })
    db.createWorkerTerminalResourceStatement({
      dispatchId: conflicting,
      worktreeId: 'wt_1',
      terminalHandle: shared,
      paneKey: null,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_B),
      ownership: 'owned'
    })
    // Rows a writer without the column left; a current writer records the incarnation's Orca session id.
    db.db.exec(
      'UPDATE dispatch_contexts SET assignee_orca_session_id = NULL, creator_orca_session_id = NULL'
    )

    backfillStructuredWorkerOrcaSessionIds(db.db)

    for (const id of [noRecord, invalidId, terminalInSessionTab, conflicting]) {
      expect(orcaSessionIds(id), id).toEqual({ assignee: null, creator: null })
    }
  })

  it('fills only NULLs and never rewrites an Orca session id a writer recorded', () => {
    db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const id = dispatch({
      handle,
      paneKey: mintStructuredWorkerPaneKey(SESSION_A),
      incarnation: structuredWorkerProcessIncarnation(SESSION_A)
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(SESSION_C, id)

    backfillStructuredWorkerOrcaSessionIds(db.db)

    expect(orcaSessionIds(id).assignee).toBe(SESSION_C)
  })

  it("fills a worker-coordinated Run over an Orca session id an older binding's generation left behind", () => {
    db = new OrchestrationDb(':memory:')
    const runFor = (sessionId: string): string => {
      const handle = mintStructuredWorkerHandle()
      const paneKey = mintStructuredWorkerPaneKey(sessionId)
      dispatch({ handle, paneKey, incarnation: structuredWorkerProcessIncarnation(sessionId) })
      return db.createRun({
        objective: sessionId,
        coordinatorHandle: handle,
        coordinatorPaneKey: paneKey
      }).id
    }
    const stale = runFor(SESSION_A)
    const recorded = runFor(SESSION_B)
    const setOrcaSessionId = db.db.prepare(
      `UPDATE runs SET coordinator_orca_session_id = ?,
         coordinator_orca_session_id_generation = consumer_generation - ?
       WHERE id = ?`
    )
    // An older binary rebound this Run to the worker over session C's id, which it cannot see.
    setOrcaSessionId.run(SESSION_C, 1, stale)
    // A writer recorded this one at the current generation.
    setOrcaSessionId.run(SESSION_C, 0, recorded)

    backfillStructuredWorkerOrcaSessionIds(db.db)

    const filled = db.getRunRaw(stale)
    expect(filled?.coordinator_orca_session_id).toBe(SESSION_A)
    expect(filled?.coordinator_orca_session_id_generation).toBe(filled?.consumer_generation)
    expect(db.getRunRaw(recorded)?.coordinator_orca_session_id).toBe(SESSION_C)
  })
})
