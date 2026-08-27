import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { requireLocalCollaborationDispatchAuthority } from './collaboration-dispatch-authority'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_PANE_KEY = 'tab_other:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROCESS_INCARNATION = 'runtime_test:term_worker:1'

describe('requireLocalCollaborationDispatchAuthority', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(handle = 'term_worker', paneKey: string | null = WORKER_PANE_KEY): string {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((h) =>
      h === handle ? paneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((h) =>
      h === handle ? PROCESS_INCARNATION : null
    )
    const task = db.createTask({ spec: 'collaboration worker' })
    return task.id
  }

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('returns the active dispatch for the assignee terminal without a capability hash', () => {
    const taskId = setup()
    const dispatch = createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)

    const resolved = requireLocalCollaborationDispatchAuthority(runtime, 'term_worker')

    expect(resolved.id).toBe(dispatch.id)
  })

  it('returns the active dispatch when the orchestration capability verifies', () => {
    const taskId = setup()
    const dispatch = createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    const resolved = requireLocalCollaborationDispatchAuthority(runtime, 'term_worker', capability)

    expect(resolved.id).toBe(dispatch.id)
  })

  it('throws dispatch_inactive when the terminal has no active dispatch', () => {
    setup()

    expect(() => requireLocalCollaborationDispatchAuthority(runtime, 'term_worker')).toThrowError(
      expect.objectContaining({ code: 'dispatch_inactive' })
    )
  })

  it('throws dispatch_inactive for a terminal that is not the dispatch assignee', () => {
    const taskId = setup()
    createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)

    expect(() => requireLocalCollaborationDispatchAuthority(runtime, 'term_other')).toThrowError(
      expect.objectContaining({ code: 'dispatch_inactive' })
    )
  })

  it('throws dispatch_capability_invalid with the DB reason when the capability is wrong', () => {
    const taskId = setup()
    const dispatch = createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    try {
      requireLocalCollaborationDispatchAuthority(runtime, 'term_worker', 'dcap_wrong')
      throw new Error('expected dispatch_capability_invalid')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      expect((error as OrchestrationError).code).toBe('dispatch_capability_invalid')
      expect((error as OrchestrationError).message).toContain('The Dispatch capability is invalid.')
    }
  })

  it('throws dispatch_capability_invalid when the dispatch has a capability but none was provided', () => {
    const taskId = setup()
    const dispatch = createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    expect(() => requireLocalCollaborationDispatchAuthority(runtime, 'term_worker')).toThrowError(
      expect.objectContaining({ code: 'dispatch_capability_invalid' })
    )
  })

  it('rejects a valid capability from a different pane (no caller-supplied identity)', () => {
    const taskId = setup()
    const dispatch = createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })
    // Caller keeps the assignee handle but resolves to a different pane (remint).
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((h) =>
      h === 'term_worker' ? OTHER_PANE_KEY : null
    )

    expect(() =>
      requireLocalCollaborationDispatchAuthority(runtime, 'term_worker', capability)
    ).toThrowError(
      expect.objectContaining({
        code: 'dispatch_capability_invalid',
        message: expect.stringContaining('The caller is not the Dispatch pane.')
      })
    )
  })

  it('throws sender_not_assignee when the assignee handle moved to a different pane without a capability', () => {
    const taskId = setup()
    createRootDispatch(db, taskId, 'term_worker', WORKER_PANE_KEY)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((h) =>
      h === 'term_worker' ? OTHER_PANE_KEY : null
    )

    expect(() => requireLocalCollaborationDispatchAuthority(runtime, 'term_worker')).toThrowError(
      expect.objectContaining({
        code: 'sender_not_assignee',
        message: expect.stringContaining('term_worker')
      })
    )
  })
})
