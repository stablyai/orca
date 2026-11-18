// The stand-in's work record is Orca's own; these hold its wiring to what the runtime does: a start
// from a conversation is recorded, the turn note names the newest worker of the lineage, proof of a
// stop or a forget closes the row.
import { describe, expect, it } from 'vitest'
import { formatBotWorkList } from '../../shared/bots/bot-work-list'
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import {
  FINISHED_EXPORT_WORLD,
  STATUS_WORLD,
  THREAD_WORLD
} from './bot-orchestration-eval-ideal-fixtures'
import { serveOrchestration } from './bot-orchestration-eval-orca'
import { closeFinishedWorkers, settleWorker } from './bot-orchestration-eval-workers'
import {
  evalTurnMessage,
  evalWorkRecord,
  recordEvalWorkerStart,
  seedEvalWork,
  listEvalWork,
  serveEvalWork
} from './bot-orchestration-eval-work'

function host(world: Partial<EvalHostState>) {
  const state: EvalHostState = {
    bots: [
      { id: 'bot-ranger', name: 'Ranger', agent: 'claude', slack: null, github: {}, linear: null }
    ],
    automations: [],
    timezone: 'UTC',
    repos: [],
    ...structuredClone(world)
  }
  const record = evalWorkRecord(() => state, ':memory:')
  const io = { record: () => {}, save: () => {} }
  return {
    state,
    record,
    call: (method: string, params: Record<string, unknown>) =>
      serveOrchestration(state, method, params, io),
    note: () => evalTurnMessage(record, state, 'hi')
  }
}

describe('the stand-in work record', () => {
  it('records a start from a conversation and names its newest worker after a follow-up', async () => {
    const { state, record, call, note } = host(THREAD_WORLD)
    const repo = state.repos.find((entry) => entry.displayName === 'orca')!
    const started = call('orchestration.workerStart', {
      spec: 'Fix the flaky export retry test.',
      worktree: 'new-top-level',
      repo: `id:${repo.id}`,
      agent: 'claude'
    })
    await recordEvalWorkerStart(record, state, started)
    expect(await note()).toMatch(/belongs to worker .*still working.*dispatch:ctx_w1/)

    settleWorker(state, 'ctx_w1', 'succeeded')
    closeFinishedWorkers(state)
    expect(await note()).toMatch(/finished\. Send follow-ups .*dispatch:ctx_w1/)
    call('orchestration.send', {
      to: 'dispatch:ctx_w1',
      subject: 'More',
      body: 'log the export id'
    })
    expect(await note()).toMatch(/still working.*dispatch:ctx_w2/)
  })

  it('keeps no record for the owner’s own Chat', async () => {
    const { state, record, call, note } = host({ ...THREAD_WORLD, conversation: undefined })
    const repo = state.repos.find((entry) => entry.displayName === 'orca')!
    const started = call('orchestration.workerStart', {
      spec: 'x',
      worktree: 'new-top-level',
      repo: `id:${repo.id}`,
      agent: 'claude'
    })
    await recordEvalWorkerStart(record, state, started)
    expect(await note()).toBe('hi')
  })

  it('closes the row on a proven stop, and on forget', async () => {
    const stopped = host(FINISHED_EXPORT_WORLD)
    await seedEvalWork(stopped.record, stopped.state)
    stopped.state.workers![0]!.state = 'stopped'
    expect(await stopped.note()).toBe('hi')

    const forgotten = host(FINISHED_EXPORT_WORLD)
    await seedEvalWork(forgotten.record, forgotten.state)
    await expect(
      serveEvalWork(forgotten.record, forgotten.state, 'bots.work.forget')
    ).resolves.toEqual({ forgotten: true })
    expect(await forgotten.note()).toBe('hi')
  })

  it('lists only the work the bot started, with its pull request', async () => {
    const { state, record } = host(STATUS_WORLD)
    await seedEvalWork(record, state)
    const listed = await listEvalWork(record, state)
    expect(listed.items).toHaveLength(2)
    // Read two hours after the stand-in's start, whenever this runs.
    const text = formatBotWorkList(listed, listed.items[0]!.startedAt! + 2 * 3_600_000)
    expect(text).toMatch(/2h/)
    expect(text).toContain('PR #36700: CI green, waiting on review')
    expect(text).toMatch(/ENG-9201.*working/)
    expect(text).not.toContain('mobile-ota')
  })
})
