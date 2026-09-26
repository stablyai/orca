import { afterEach, describe, expect, it } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { OrchestrationDb } from '../../db'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

const CHAT_X_ID = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const CHAT_X = formatOrcaSessionAddress(CHAT_X_ID)
const CHAT_Y_ID = testOrcaSessionId('6d2a9e41-0c7b-4f38-9a15-b3e8c1d57f20')
const CHAT_Y = formatOrcaSessionAddress(CHAT_Y_ID)
const WORKER_SESSION = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const WORKER_ADDRESS = formatOrcaSessionAddress(WORKER_SESSION)
const OTHER_WORKER_SESSION = testOrcaSessionId('2e8b4d61-5a3c-4e97-b0f2-7c1d9a6e3b54')
const PTY_PANE = 'tab_pty:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const UNCAPPED = Number.MAX_SAFE_INTEGER

function chat(orcaSessionId: OrcaSessionId) {
  return { terminalHandle: null, paneKey: null, orcaSessionId }
}

describe('Run binding by Orca session id', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function createChatRun(orcaSessionId: OrcaSessionId, objective = 'chat run') {
    return db.createRun({
      objective,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: orcaSessionId
    })
  }

  function directMail(runId: string, to: string, subject = 'direct') {
    return db.insertMessage({ from: 'term_sender', to, subject, body: '', runId })
  }

  function structuredWorker(sessionId = WORKER_SESSION) {
    return {
      terminalHandle: mintStructuredWorkerHandle(),
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      orcaSessionId: sessionId
    }
  }

  // A binary without the Orca session id column: its bindRun and unbindOtherRunsForPane statements.
  function olderBinaryRebind(runId: string, handle: string, paneKey: string) {
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(handle, paneKey, runId)
  }

  function olderBinaryUnbind(runId: string) {
    db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
           consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(runId)
  }

  /** Unread mail addressed straight to `to`, as a row written before the address was cached. */
  function strayMail(runId: string, to: string) {
    const message = directMail(runId, 'term_late', `to ${to}`)
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(to, message.id)
    return message.id
  }

  it('binds a handle-less session by its Orca session id and remembers its session address', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_orca_session_id: CHAT_X_ID
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))?.id).toBe(run.id)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_X)).toEqual([run.id])
    // Mail to the session's address reaches the Run mailbox, as mail to a coordinator handle does.
    expect(directMail(run.id, CHAT_X).to_handle).toBe(`run:${run.id}`)
  })

  it("never unbinds another session's Run, and unbinds only the same session's other Runs", () => {
    db = new OrchestrationDb(':memory:')
    const ptyRun = db.createRun({
      objective: 'pty',
      coordinatorHandle: 'term_pty',
      coordinatorPaneKey: PTY_PANE
    })
    const yRun = createChatRun(CHAT_Y_ID, 'y')
    const xFirst = createChatRun(CHAT_X_ID, 'x first')
    const pending = db.insertMessage({
      from: 'term_sender',
      to: 'term_late',
      subject: 'queued before the rebind',
      body: '',
      runId: xFirst.id
    })
    // Mail addressed to the session that the cache did not reroute on insert, as a pre-cache row.
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_X, pending.id)
    const generation = db.getRunRaw(xFirst.id)?.consumer_generation ?? 0

    const xSecond = createChatRun(CHAT_X_ID, 'x second')

    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))?.id).toBe(xSecond.id)
    expect(db.getCurrentRunForCoordinator(chat(CHAT_Y_ID))?.id).toBe(yRun.id)
    expect(db.getRunRaw(yRun.id)?.coordinator_orca_session_id).toBe(CHAT_Y_ID)
    expect(db.getRunRaw(ptyRun.id)?.coordinator_pane_key).toBe(PTY_PANE)
    expect(db.getRunRaw(xFirst.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_orca_session_id: null,
      consumer_generation: generation + 1
    })
    // Pending coordinator mail follows the Run, as it does when a pane is unbound.
    expect(db.getMessageById(pending.id)?.to_handle).toBe(`run:${xFirst.id}`)
  })

  it('stops counting an Orca session id once a binary without the column rebinds the Run to a terminal', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)
    olderBinaryRebind(run.id, 'term_taker', PTY_PANE)

    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))).toBeUndefined()
    expect(
      db.getCurrentRunForCoordinator({
        terminalHandle: 'term_taker',
        paneKey: PTY_PANE,
        orcaSessionId: null
      })?.id
    ).toBe(run.id)
    createChatRun(CHAT_X_ID, 'next')
    expect(db.getRunRaw(run.id)?.coordinator_handle).toBe('term_taker')
  })

  it('does not hand a chat back a Run an older binary rebound and then unbound', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)
    olderBinaryRebind(run.id, 'term_taker', PTY_PANE)
    olderBinaryUnbind(run.id)

    // Handle and pane are gone and the id is still there: the shape of a live chat binding.
    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_orca_session_id: CHAT_X_ID
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))).toBeUndefined()
    const next = createChatRun(CHAT_X_ID, 'next')
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))?.id).toBe(next.id)
  })

  it("stops counting a structured worker's Orca session id once an older binary unbinds its Run", () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorOrcaSessionId: worker.orcaSessionId
    })
    expect(db.getCurrentRunForCoordinator(worker)?.id).toBe(run.id)
    olderBinaryUnbind(run.id)
    expect(db.getCurrentRunForCoordinator(worker)).toBeUndefined()
    expect(db.getCurrentRunForCoordinator(chat(worker.orcaSessionId))).toBeUndefined()
  })

  it('remembers a coordinating structured worker at its handle, and the v42 trigger its inert session address', () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorOrcaSessionId: worker.orcaSessionId
    })

    expect(db.getRunMailboxOwnerIdsForHandle(worker.terminalHandle)).toEqual([run.id])
    expect(db.getRunMailboxOwnerIdsForHandle(WORKER_ADDRESS)).toEqual([run.id])
    expect(directMail(run.id, WORKER_ADDRESS).to_handle).toBe(`run:${run.id}`)
  })

  it('hands a Run to a different session like a terminal takeover: fenced, rerouted, remembered', () => {
    db = new OrchestrationDb(':memory:')
    const run = createChatRun(CHAT_X_ID)
    const pending = directMail(run.id, 'term_late')
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(CHAT_X, pending.id)
    const before = db.getRunRaw(run.id)?.consumer_generation ?? 0

    db.bindRun({
      runId: run.id,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT_Y_ID
    })

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_orca_session_id: CHAT_Y_ID,
      consumer_generation: before + 1
    })
    expect(db.getCurrentRunForCoordinator(chat(CHAT_X_ID))).toBeUndefined()
    expect(db.getCurrentRunForCoordinator(chat(CHAT_Y_ID))?.id).toBe(run.id)
    expect(db.getMessageById(pending.id)?.to_handle).toBe(`run:${run.id}`)
    expect(db.getRunMailboxOwnerIdsForHandle(CHAT_Y)).toEqual([run.id])
  })

  it('rebinding the same session is not a new consumer, and fills a missing Orca session id in place', () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const run = db.createRun({
      objective: 'worker coordinates',
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey
    })
    // As an older binary writes the row: no Orca session id, and no generation for one.
    db.db
      .prepare('UPDATE runs SET coordinator_orca_session_id_generation = NULL WHERE id = ?')
      .run(run.id)
    const before = db.getRunRaw(run.id)?.consumer_generation

    db.bindRun({
      runId: run.id,
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorOrcaSessionId: worker.orcaSessionId
    })

    expect(db.getRunRaw(run.id)).toMatchObject({
      coordinator_orca_session_id: WORKER_SESSION,
      consumer_generation: before
    })
    // Written at the current generation, so the filled id counts on its own.
    expect(db.getCurrentRunForCoordinator(chat(WORKER_SESSION))?.id).toBe(run.id)
  })

  it("reroutes and remembers each worker's one mailbox address when one takes a Run from another", () => {
    db = new OrchestrationDb(':memory:')
    const first = structuredWorker()
    const second = structuredWorker(OTHER_WORKER_SESSION)
    const run = db.createRun({
      objective: 'first worker coordinates',
      coordinatorHandle: first.terminalHandle,
      coordinatorPaneKey: first.paneKey,
      coordinatorOrcaSessionId: first.orcaSessionId
    })
    // A worker's mailbox address is its handle; nothing writes mail to its session address.
    const addresses = [first.terminalHandle, second.terminalHandle]
    const stray = addresses.map((address) => strayMail(run.id, address))

    db.bindRun({
      runId: run.id,
      coordinatorHandle: second.terminalHandle,
      coordinatorPaneKey: second.paneKey,
      coordinatorOrcaSessionId: second.orcaSessionId
    })

    for (const id of stray) {
      expect(db.getMessageById(id)?.to_handle).toBe(`run:${run.id}`)
    }
    for (const address of addresses) {
      expect(db.getRunMailboxOwnerIdsForHandle(address)).toEqual([run.id])
    }
  })

  it("reroutes a worker's mailbox address when its next Run unbinds the last", () => {
    db = new OrchestrationDb(':memory:')
    const worker = structuredWorker()
    const bind = {
      coordinatorHandle: worker.terminalHandle,
      coordinatorPaneKey: worker.paneKey,
      coordinatorOrcaSessionId: worker.orcaSessionId
    }
    const last = db.createRun({ objective: 'last', ...bind })
    const stray = [strayMail(last.id, worker.terminalHandle)]

    db.createRun({ objective: 'next', ...bind })

    for (const id of stray) {
      expect(db.getMessageById(id)?.to_handle).toBe(`run:${last.id}`)
    }
  })
})

describe('Dispatch Orca session ids recorded by every writer', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('records the assignee Orca session id from a structured incarnation and a creator one', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'r',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT_X_ID
    })
    const handle = mintStructuredWorkerHandle()
    const assigned = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'structured' }).id,
      assigneeHandle: handle,
      assigneePaneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      creator: { kind: 'session', orcaSessionId: CHAT_X_ID },
      maxDepth: UNCAPPED
    })
    const pty = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'pty' }).id,
      assigneeHandle: 'term_pty',
      assigneePaneKey: PTY_PANE,
      processIncarnation: 'pty_proc:1',
      creator: { kind: 'terminal', handle: 'term_c', paneKey: OTHER_PANE },
      maxDepth: UNCAPPED
    })

    expect(assigned).toMatchObject({
      assignee_orca_session_id: WORKER_SESSION,
      creator_handle: null,
      creator_pane_key: null,
      creator_orca_session_id: CHAT_X_ID
    })
    expect(pty).toMatchObject({ assignee_orca_session_id: null, creator_orca_session_id: null })
  })

  it('nests under the Dispatch a handle-less creator is assigned by its Orca session id', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'r',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: OTHER_PANE
    })
    const parent = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'parent' }).id,
      assigneeHandle: mintStructuredWorkerHandle(),
      assigneePaneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      creator: { kind: 'system' },
      maxDepth: UNCAPPED
    })

    const child = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'child' }).id,
      assigneeHandle: 'term_child',
      assigneePaneKey: PTY_PANE,
      processIncarnation: 'pty_proc:2',
      creator: { kind: 'session', orcaSessionId: WORKER_SESSION },
      maxDepth: UNCAPPED
    })

    expect(child).toMatchObject({ creator_dispatch_id: parent.id, depth: parent.depth + 1 })
  })

  it('records the starting creator and the attached assignee of a worker-start', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'r',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT_X_ID
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: CHAT_X_ID },
      maxDepth: UNCAPPED,
      taskSpec: 'work',
      taskRunId: run.id,
      startOptions: {}
    })
    expect(started.dispatch).toMatchObject({
      creator_orca_session_id: CHAT_X_ID,
      assignee_orca_session_id: null
    })

    const handle = mintStructuredWorkerHandle()
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: mintStructuredWorkerPaneKey(WORKER_SESSION),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_SESSION),
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable'
    })

    expect(db.getDispatchContextById(started.dispatch.id)?.assignee_orca_session_id).toBe(
      WORKER_SESSION
    )
  })
})
