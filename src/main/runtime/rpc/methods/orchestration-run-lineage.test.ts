import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUN_METHODS } from './orchestration-runs'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

const GENERAL_PANE = 'tab_general:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAPTAIN_PANE = 'tab_captain:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('Run lineage RPC', () => {
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
    return { db, ctx: { runtime } }
  }

  async function call(ctx: RpcContext, name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_RUN_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  // Dispatches the captain terminal inside the general's Run, the way a nested wave does.
  function dispatchCaptain(store: OrchestrationDb, runId: string): void {
    const task = store.createTask({ spec: 'lead the alpha lane', runId })
    store.createDispatchContext(task.id, 'term_captain', CAPTAIN_PANE)
  }

  it('records an explicit --parent Run', async () => {
    const { ctx } = setup()
    const general = (await call(ctx, 'orchestration.runCreate', {
      objective: 'wave',
      from: 'term_general'
    })) as { run: { id: string } }

    const captain = (await call(ctx, 'orchestration.runCreate', {
      objective: 'alpha lane',
      from: 'term_captain',
      parent: general.run.id
    })) as { run: { id: string; parent_run_id: string | null } }

    expect(captain.run.parent_run_id).toBe(general.run.id)
  })

  it('infers the parent from the creating terminal active Dispatch', async () => {
    const { db: store, ctx } = setup()
    const general = (await call(ctx, 'orchestration.runCreate', {
      objective: 'wave',
      from: 'term_general'
    })) as { run: { id: string } }
    dispatchCaptain(store, general.run.id)

    const captain = (await call(ctx, 'orchestration.runCreate', {
      objective: 'alpha lane',
      from: 'term_captain'
    })) as { run: { parent_run_id: string | null } }

    expect(captain.run.parent_run_id).toBe(general.run.id)
  })

  it('prefers an explicit parent over the inferred one', async () => {
    const { db: store, ctx } = setup()
    const general = (await call(ctx, 'orchestration.runCreate', {
      objective: 'wave',
      from: 'term_general'
    })) as { run: { id: string } }
    const other = (await call(ctx, 'orchestration.runCreate', {
      objective: 'other wave',
      from: 'term_general'
    })) as { run: { id: string } }
    dispatchCaptain(store, general.run.id)

    const captain = (await call(ctx, 'orchestration.runCreate', {
      objective: 'alpha lane',
      from: 'term_captain',
      parent: other.run.id
    })) as { run: { parent_run_id: string | null } }

    expect(captain.run.parent_run_id).toBe(other.run.id)
  })

  it('leaves an undispatched coordinator Run unparented', async () => {
    const { ctx } = setup()
    const general = (await call(ctx, 'orchestration.runCreate', {
      objective: 'wave',
      from: 'term_general'
    })) as { run: { parent_run_id: string | null } }

    expect(general.run.parent_run_id).toBeNull()
  })

  it('refuses an unknown parent Run without applying effects', async () => {
    const { ctx } = setup()

    await expect(
      call(ctx, 'orchestration.runCreate', {
        objective: 'alpha lane',
        from: 'term_captain',
        parent: 'run_missing'
      })
    ).rejects.toMatchObject({ code: 'run_not_found', data: { effectsApplied: false } })
  })

  it('walks the wave from either end through run-show and run-list', async () => {
    const { ctx } = setup()
    const general = (await call(ctx, 'orchestration.runCreate', {
      objective: 'wave',
      from: 'term_general'
    })) as { run: { id: string } }
    const captain = (await call(ctx, 'orchestration.runCreate', {
      objective: 'alpha lane',
      from: 'term_captain',
      parent: general.run.id
    })) as { run: { id: string } }

    const shown = (await call(ctx, 'orchestration.runShow', { id: general.run.id })) as {
      run: { parent_run_id: string | null }
      childRunIds: string[]
    }
    const listed = (await call(ctx, 'orchestration.runList', { parent: general.run.id })) as {
      runs: { id: string }[]
    }

    expect(shown.run.parent_run_id).toBeNull()
    expect(shown.childRunIds).toEqual([captain.run.id])
    expect(listed.runs.map((run) => run.id)).toEqual([captain.run.id])
  })
})
