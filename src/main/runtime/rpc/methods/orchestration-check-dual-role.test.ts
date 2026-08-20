import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

const GENERAL_PANE = 'tab_general:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAPTAIN_PANE = 'tab_captain:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('check on a terminal that is both dispatched and coordinator-bound', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function setup(): { db: OrchestrationDb; ctx: RpcContext } {
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_general' ? GENERAL_PANE : handle === 'term_captain' ? CAPTAIN_PANE : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    return { db, ctx: { runtime } }
  }

  async function call(ctx: RpcContext, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.check')
    if (!method) {
      throw new Error('orchestration.check is not registered')
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  // A captain dispatched inside the general's Run, then bound as coordinator of its own Run.
  function buildDualRoleCaptain(store: OrchestrationDb): {
    dispatchId: string
    captainRun: string
  } {
    const generalRun = store.createRun({
      objective: 'wave',
      coordinatorHandle: 'term_general',
      coordinatorPaneKey: GENERAL_PANE
    })
    const task = store.createTask({ spec: 'lead the alpha lane', runId: generalRun.id })
    const dispatch = store.createDispatchContext(task.id, 'term_captain', CAPTAIN_PANE)
    const captainRun = store.createRun({
      objective: 'alpha lane',
      coordinatorHandle: 'term_captain',
      coordinatorPaneKey: CAPTAIN_PANE
    })
    return { dispatchId: dispatch.id, captainRun: captainRun.id }
  }

  // The same two roles, but the Dispatch is a remote attachment: the captain runs on this machine
  // as a federated worker while it coordinates a Run of its own here.
  function buildDualRoleRemoteCaptain(store: OrchestrationDb): {
    dispatchId: string
    captainRun: string
  } {
    const dispatchId = 'ctx_remote_captain'
    store.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_captain',
      homePeerFingerprint: 'home-peer',
      protocolVersion: 2,
      runtimeEpoch: 'epoch_test',
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: 'attach-captain',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach-captain-payload'
      }
    })
    store.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: CAPTAIN_PANE,
      processIncarnation: 'runtime_test:term_captain:1',
      worktreeId: 'repo::captain',
      terminalHandle: 'term_captain',
      setupState: 'not_applicable',
      effects: []
    })
    store.markRemoteAttachmentReady(dispatchId)
    const captainRun = store.createRun({
      objective: 'alpha lane',
      coordinatorHandle: 'term_captain',
      coordinatorPaneKey: CAPTAIN_PANE
    })
    return { dispatchId, captainRun: captainRun.id }
  }

  it('reports the Dispatch its Run binding shadowed', async () => {
    const { db: store, ctx } = setup()
    const { dispatchId } = buildDualRoleCaptain(store)

    const checked = (await call(ctx, { terminal: 'term_captain' })) as {
      runId: string
      dispatchId?: string
      shadowedDispatchId?: string
    }

    expect(checked.shadowedDispatchId).toBe(dispatchId)
    expect(checked.dispatchId).toBeUndefined()
  })

  it('reports a remote Dispatch attachment its Run binding shadowed', async () => {
    const { db: store, ctx } = setup()
    const { dispatchId } = buildDualRoleRemoteCaptain(store)

    const checked = (await call(ctx, { terminal: 'term_captain' })) as {
      runId: string
      dispatchId?: string
      shadowedDispatchId?: string
    }

    expect(checked.shadowedDispatchId).toBe(dispatchId)
    expect(checked.dispatchId).toBeUndefined()
  })

  it('does not advertise a remote attachment whose worker process is gone', async () => {
    const { db: store, ctx } = setup()
    buildDualRoleRemoteCaptain(store)
    // A restarted pane is a new process; the attachment names the dead one.
    vi.spyOn(ctx.runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:restarted:2'
    )

    const checked = (await call(ctx, { terminal: 'term_captain' })) as {
      shadowedDispatchId?: string
    }

    expect(checked.shadowedDispatchId).toBeUndefined()
  })

  it('reads the Dispatch shelf with --as dispatch while the Run stays bound', async () => {
    const { db: store, ctx } = setup()
    const { dispatchId, captainRun } = buildDualRoleCaptain(store)
    store.insertMessage({
      from: 'term_general',
      to: `dispatch:${dispatchId}`,
      subject: 'lane guidance',
      runId: captainRun
    })

    const checked = (await call(ctx, { terminal: 'term_captain', as: 'dispatch' })) as {
      dispatchId: string
      messages: { subject: string }[]
      shadowedDispatchId?: string
    }

    expect(checked.dispatchId).toBe(dispatchId)
    expect(checked.messages.map((message) => message.subject)).toEqual(['lane guidance'])
    expect(checked.shadowedDispatchId).toBeUndefined()
    // The coordinator binding is untouched by reading the other mailbox.
    expect(store.getCurrentRunForPane(CAPTAIN_PANE)?.id).toBe(captainRun)
  })

  it('keeps reporting the shadowed Dispatch when an acknowledged wait is interrupted', async () => {
    const { db: store, ctx } = setup()
    const { dispatchId, captainRun } = buildDualRoleCaptain(store)
    store.insertMessage({
      from: 'term_worker',
      to: `run:${captainRun}`,
      subject: 'lane report',
      runId: captainRun
    })

    const first = (await call(ctx, { terminal: 'term_captain' })) as { deliveryId: string }

    // Hold the wait open, fence the consumer under it, then let it finish — the interrupted
    // shape is the one that used to drop the shadow.
    let releaseWait: (() => void) | undefined
    let waitStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve
    })
    vi.spyOn(ctx.runtime, 'waitForMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWait = () => resolve('notified')
          waitStarted?.()
        })
    )

    const pending = call(ctx, {
      terminal: 'term_captain',
      ack: first.deliveryId,
      wait: true,
      timeoutMs: 10_000
    }) as Promise<{ waitInterrupted?: string; shadowedDispatchId?: string }>
    await started
    store.bindRun({
      runId: captainRun,
      coordinatorHandle: 'term_captain_reissued',
      coordinatorPaneKey: CAPTAIN_PANE
    })
    releaseWait?.()

    const interrupted = await pending
    expect(interrupted.waitInterrupted).toBe('consumer_fenced')
    // Why this matters: the text output hangs its Dispatch-mail guidance on this field, so a
    // dual-role captain that acknowledged and got fenced would never be told its other mailbox
    // exists — exactly when it most needs to look at it.
    expect(interrupted.shadowedDispatchId).toBe(dispatchId)
  })

  it('keeps the Run mailbox as the default for a dual-role terminal', async () => {
    const { db: store, ctx } = setup()
    const { captainRun } = buildDualRoleCaptain(store)
    store.insertMessage({
      from: 'term_worker',
      to: `run:${captainRun}`,
      subject: 'lane status',
      runId: captainRun
    })

    const checked = (await call(ctx, { terminal: 'term_captain' })) as {
      runId: string
      messages: { subject: string }[]
    }

    expect(checked.runId).toBe(captainRun)
    expect(checked.messages.map((message) => message.subject)).toEqual(['lane status'])
  })

  it('leaves a coordinator that holds no Dispatch unchanged', async () => {
    const { db: store, ctx } = setup()
    store.createRun({
      objective: 'wave',
      coordinatorHandle: 'term_general',
      coordinatorPaneKey: GENERAL_PANE
    })

    const checked = (await call(ctx, { terminal: 'term_general' })) as {
      shadowedDispatchId?: string
    }

    expect(checked.shadowedDispatchId).toBeUndefined()
  })

  it('refuses --as dispatch when the terminal holds no active Dispatch', async () => {
    const { db: store, ctx } = setup()
    store.createRun({
      objective: 'wave',
      coordinatorHandle: 'term_general',
      coordinatorPaneKey: GENERAL_PANE
    })

    await expect(call(ctx, { terminal: 'term_general', as: 'dispatch' })).rejects.toMatchObject({
      code: 'dispatch_not_found'
    })
  })

  it('refuses --as dispatch combined with an explicit --run', async () => {
    const { db: store, ctx } = setup()
    const { captainRun } = buildDualRoleCaptain(store)

    await expect(
      call(ctx, { terminal: 'term_captain', as: 'dispatch', run: captainRun })
    ).rejects.toThrow(/--run selects a Run mailbox/)
  })
})
