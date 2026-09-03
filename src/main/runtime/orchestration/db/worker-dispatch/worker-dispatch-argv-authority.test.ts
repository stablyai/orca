import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const INCARNATION = 'runtime:pty:1'
const TOKEN_HASH = createHash('sha256').update('launch-token').digest('hex')

describe('argv worker authority: mint before spawn, bind after', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function startDispatch() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'argv worker' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    return { d: db, dispatchId: started.dispatch.id }
  }

  function bindParams(dispatchId: string, overrides?: { launchTokenHash?: string }) {
    return {
      dispatchId,
      handle: 'term_worker',
      paneKey: PANE,
      processIncarnation: INCARNATION,
      launchTokenHash: overrides?.launchTokenHash ?? TOKEN_HASH,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      terminalOwnership: 'created' as const
    }
  }

  it('mints an unbound capability that authorizes nothing until bind', () => {
    const { d, dispatchId } = startDispatch()
    const capability = d.mintStartingWorkerCapability({ dispatchId })
    expect(capability).toMatch(/^dcap_/)
    expect(d.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'pending',
      assignee_handle: null,
      assignee_pane_key: null,
      process_incarnation: null
    })
    // Why: the whole pre-spawn mint is safe only because an unbound
    // capability is inert — this is the invariant the argv path leans on.
    expect(
      d.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: PANE,
        processIncarnation: INCARNATION
      })
    ).toMatchObject({ valid: false, reason: 'The caller is not the Dispatch pane.' })
  })

  it('refuses a second mint instead of silently rotating the argv-baked capability', () => {
    const { d, dispatchId } = startDispatch()
    d.mintStartingWorkerCapability({ dispatchId })
    expect(() => d.mintStartingWorkerCapability({ dispatchId })).toThrow(
      /already has a lifecycle capability/
    )
  })

  it('refuses to mint for a dispatch that is not starting', () => {
    const { d, dispatchId } = startDispatch()
    d.failWorkerStart(dispatchId, 'terminal_create', 'spawn failed')
    expect(() => d.mintStartingWorkerCapability({ dispatchId })).toThrow(/is not starting/)
  })

  it('refuses to bind when nothing was minted', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    expect(() => d.bindStartingWorkerAuthority(bindParams(dispatchId))).toThrow(
      /has no minted capability to bind/
    )
  })

  it('refuses to bind when the durable launch-token commitment is absent', () => {
    const { d, dispatchId } = startDispatch()
    const capability = d.mintStartingWorkerCapability({ dispatchId })
    expect(() => d.bindStartingWorkerAuthority(bindParams(dispatchId))).toThrow(
      /launch-token commitment does not match/
    )
    expect(d.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: null,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(
      d.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: PANE,
        processIncarnation: INCARNATION
      })
    ).toMatchObject({ valid: false })
  })

  it('refuses to bind a pane whose launch token does not match the commitment', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    const capability = d.mintStartingWorkerCapability({ dispatchId })
    const wrongHash = createHash('sha256').update('some-other-token').digest('hex')
    expect(() =>
      d.bindStartingWorkerAuthority(bindParams(dispatchId, { launchTokenHash: wrongHash }))
    ).toThrow(/launch-token commitment does not match/)
    expect(d.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: null,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(
      d.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: PANE,
        processIncarnation: INCARNATION
      })
    ).toMatchObject({ valid: false })
  })

  it('refuses to bind a pane that presents no launch token when one was committed', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    d.mintStartingWorkerCapability({ dispatchId })
    const params = bindParams(dispatchId)
    const { launchTokenHash: _omitted, ...withoutToken } = params
    expect(() => d.bindStartingWorkerAuthority(withoutToken)).toThrow(
      /launch-token commitment does not match/
    )
  })

  it('never resurrects a capability revoked between mint and bind', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    d.mintStartingWorkerCapability({ dispatchId })
    d.revokeDispatchCapability(dispatchId)
    expect(() => d.bindStartingWorkerAuthority(bindParams(dispatchId))).toThrow(
      /capability is revoked/
    )
    // Why: the atomic prepare path clears capability_revoked_at because
    // nothing can revoke inside one transaction. Across two transactions
    // that reset would resurrect a revocation, so bind must keep it.
    expect(d.getDispatchContextById(dispatchId)?.capability_revoked_at).not.toBeNull()
  })

  it('binds the spawned pane and only then makes the capability valid for that exact pane', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    const capability = d.mintStartingWorkerCapability({ dispatchId })
    d.bindStartingWorkerAuthority(bindParams(dispatchId))
    expect(d.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_pane_key: PANE,
      process_incarnation: INCARNATION,
      launch_token_hash: TOKEN_HASH
    })
    expect(
      d.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: PANE,
        processIncarnation: INCARNATION
      })
    ).toEqual({ valid: true })
    expect(
      d.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: OTHER_PANE,
        processIncarnation: INCARNATION
      })
    ).toMatchObject({ valid: false })
    expect(d.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      terminal_handle: 'term_worker',
      pane_key: PANE
    })
  })

  it('refuses to bind a pane that already carries another active dispatch', () => {
    const { d, dispatchId } = startDispatch()
    d.commitDispatchLaunchTokenHash(dispatchId, TOKEN_HASH)
    d.mintStartingWorkerCapability({ dispatchId })
    d.bindStartingWorkerAuthority(bindParams(dispatchId))
    d.markWorkerDispatchReady(dispatchId)

    const rival = d.createTask({ spec: 'rival argv worker' })
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: rival.id,
      startOptions: {}
    })
    d.commitDispatchLaunchTokenHash(second.dispatch.id, TOKEN_HASH)
    d.mintStartingWorkerCapability({ dispatchId: second.dispatch.id })
    expect(() => d.bindStartingWorkerAuthority(bindParams(second.dispatch.id))).toThrow(
      /already has an active dispatch/
    )
  })
})
