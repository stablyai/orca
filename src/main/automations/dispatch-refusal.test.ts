import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AutomationRunWriter } from './automation-run-writer'
import { UNEVALUABLE_SCHEDULE, recordUnevaluableAutomation } from './dispatch-refusal'

const brokenAutomation: Automation = {
  id: 'a1',
  name: 'Broken schedule',
  prompt: 'Check the repo',
  precheck: null,
  agentId: 'claude',
  projectId: 'r1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'wt1',
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: '0 9 32 * *',
  dtstart: 0,
  enabled: true,
  nextRunAt: 1000,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 0,
  updatedAt: 0
}

const makeRun = (id: string): AutomationRun => ({
  id,
  automationId: brokenAutomation.id,
  title: 'Broken schedule run',
  scheduledFor: brokenAutomation.nextRunAt,
  status: 'pending',
  trigger: 'scheduled',
  workspaceId: brokenAutomation.workspaceId,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 0
})

/** Records what the writer was asked to do, with `repeatSkip` standing in for a fold or not. */
function makeRunWriter(foldsRepeat: boolean): {
  writer: AutomationRunWriter
  created: string[]
  updated: { status: string; error?: string | null }[]
} {
  const created: string[] = []
  const updated: { status: string; error?: string | null }[] = []
  const writer: AutomationRunWriter = {
    repeatSkip: () => (foldsRepeat ? makeRun('folded') : null),
    createRun: () => {
      const run = makeRun(`run-${created.length + 1}`)
      created.push(run.id)
      return run
    },
    updateRun: (args) => {
      updated.push({ status: args.status, error: args.error })
      return { ...makeRun(args.runId), status: args.status, error: args.error ?? null }
    }
  }
  return { writer, created, updated }
}

describe('recordUnevaluableAutomation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes one run and logs once when the record is newly broken', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { writer, created, updated } = makeRunWriter(false)

    recordUnevaluableAutomation({
      runs: writer,
      automation: brokenAutomation,
      error: new Error('Invalid cron day of month.')
    })

    expect(created).toEqual(['run-1'])
    expect(updated).toEqual([{ status: 'skipped_unavailable', error: UNEVALUABLE_SCHEDULE }])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  // The record is retried every tick on purpose, so a repaired schedule resumes on its own.
  // The fold is what keeps that from writing a row, and logging, once per tick forever.
  it('stays silent on a record it has already reported', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { writer, created } = makeRunWriter(true)

    for (let tick = 0; tick < 5; tick += 1) {
      recordUnevaluableAutomation({
        runs: writer,
        automation: brokenAutomation,
        error: new Error('Invalid cron day of month.')
      })
    }

    expect(created).toEqual([])
    expect(logged).not.toHaveBeenCalled()
  })
})
