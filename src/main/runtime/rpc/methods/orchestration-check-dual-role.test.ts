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
