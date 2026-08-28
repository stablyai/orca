import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

/** A_WORKER_MUST_BE_ABLE_TO_REPORT_FROM_ITS_OWN_SESSION
 *
 *  A capability-backed Dispatch used to accept a completion only on presentation
 *  of its bearer token, which forced the worker's model to hold and repeat a
 *  secret. A secret that has to travel through a transcript can be copied out of
 *  one, so that is a weaker fact than the runtime's own attested identity.
 *
 *  The tokenless path is therefore authorised by attestation ALONE. It must not
 *  be reachable through the caller-declared `--from` handle: `from` is routing
 *  metadata, and resolving a pane through it would let any terminal name the
 *  worker and inherit its identity.
 */
describe('A_WORKER_MUST_BE_ABLE_TO_REPORT_FROM_ITS_OWN_SESSION', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup(true))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it('lets an ATTESTED worker report from its own session with no token, and nothing else', async () => {
    setup()
    const task = db.createTask({ spec: 'capability work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime_test:term_worker:1'
    )
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1'
    })
    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })
    const attested: OrchestrationCompatibilityCallerAuthority = {
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: 'tab_worker:leaf_worker',
      terminalHandle: 'term_worker',
      processIncarnation: 'runtime_test:term_worker:1',
      launchTokenHash: 'hash'
    }

    // THE DECISIVE NEGATIVE: another terminal declares --from term_worker and
    // presents no capability. `from` is caller-declared routing metadata, so
    // resolving the pane through it would hand this caller the real worker's
    // identity. Nothing is attested for term_worker here, so it must fail.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:term_worker:1')
    ctx = { runtime }
    const impersonated = (await call('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload
    })) as { lifecycle: { code: string } }
    expect(impersonated.lifecycle.code).toBe('dispatch_capability_invalid')
    expect(db.getTask(task.id)?.status).toBe('dispatched')

    // Attested, but for a DIFFERENT pane than the Dispatch assignee.
    ctx = {
      runtime,
      orchestrationCompatibilityCallerAuthority: {
        ...attested,
        paneKey: 'tab_foreign:leaf_foreign'
      }
    }
    const foreignPane = (await call('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload
    })) as { lifecycle: { code: string } }
    expect(foreignPane.lifecycle.code).toBe('dispatch_capability_invalid')

    // Attested for the right pane but a stale process incarnation.
    ctx = {
      runtime,
      orchestrationCompatibilityCallerAuthority: {
        ...attested,
        processIncarnation: 'runtime_test:term_worker:2'
      }
    }
    const stale = (await call('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload
    })) as { lifecycle: { code: string } }
    expect(stale.lifecycle.code).toBe('dispatch_capability_invalid')
    expect(db.getTask(task.id)?.status).toBe('dispatched')

    // THE POSITIVE: the actual attested worker session, no token pasted.
    ctx = { runtime, orchestrationCompatibilityCallerAuthority: attested }
    await call('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload
    })
    expect(db.getTask(task.id)?.status).toBe('completed')
  })
})
