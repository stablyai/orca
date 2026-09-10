import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import type { RuntimeRunSettlementResult } from '../../../shared/runtime-worktree-contracts'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run ? `${r.run.id} ${r.run.objective}` : 'No Run is bound to this terminal.'
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number; completion?: unknown }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) =>
                  `${run.id}${run.legacy ? ' [legacy, inspect only]' : run.completion ? ' [completed]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
        completion?: {
          summary: string
          evidence: string[]
          waivers: { task_id: string; reason: string }[]
          completed_by_handle: string
          completed_by_generation: number
          completed_at: string
        }
      }
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(result, json, (r) => formatRunDetails(r.run))
  },

  'orchestration run-settle': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<RuntimeRunSettlementResult>(
      client,
      flags,
      'orchestration.runSettle',
      { id: getRequiredStringFlag(flags, 'id'), from }
    )
    printResult(result, json, (settlement) => {
      const rows = settlement.worktrees.map((worktree) => {
        const host = worktree.executionHostId ? ` on ${worktree.executionHostId}` : ''
        const detail = [worktree.cause, worktree.action].filter(Boolean).join(' ')
        return `${worktree.disposition}: ${worktree.worktreeId}${host}${detail ? `\n  ${detail}` : ''}`
      })
      const warnings = settlement.warnings.map((warning) => `Warning: ${warning}`)
      return [`Run ${settlement.runId} settlement: ${settlement.state}`, ...rows, ...warnings].join(
        '\n'
      )
    })
  },

  'orchestration run-complete': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      completion: {
        run_id: string
        summary: string
        evidence: string[]
        waivers: { task_id: string; reason: string }[]
        completed_at: string
      }
      duplicate: boolean
    }>(client, flags, 'orchestration.runComplete', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      summary: getRequiredStringFlag(flags, 'summary'),
      evidence: getRepeatedStringFlag(flags, 'evidence'),
      waivers: getRepeatedStringFlag(flags, 'waive-task').map(parseTaskWaiver)
    })
    printResult(result, json, ({ completion, duplicate }) => {
      const waived = completion.waivers.length
        ? `; ${completion.waivers.length} required Task${completion.waivers.length === 1 ? '' : 's'} waived`
        : ''
      return `Run ${completion.run_id} ${duplicate ? 'was already completed' : 'completed'}: ${completion.summary}${waived}`
    })
  }
}

function parseTaskWaiver(value: string): { task_id: string; reason: string } {
  const separator = value.indexOf('=')
  const taskId = separator === -1 ? '' : value.slice(0, separator).trim()
  const reason = separator === -1 ? '' : value.slice(separator + 1).trim()
  if (!taskId || !reason) {
    throw new Error('--waive-task must use <task_id>=<reason>.')
  }
  return { task_id: taskId, reason }
}

function formatRunDetails(run: {
  id: string
  objective: string
  consumer_generation: number
  legacy: number
  created_at: string
  completion?: {
    summary: string
    evidence: string[]
    waivers: { task_id: string; reason: string }[]
    completed_by_handle: string
    completed_by_generation: number
    completed_at: string
  }
}): string {
  const heading = `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}\nconsumer generation ${run.consumer_generation}; created ${run.created_at}`
  if (!run.completion) {
    return heading
  }
  const completion = run.completion
  const evidence = completion.evidence.map((entry) => `  - ${entry}`)
  const waivers = completion.waivers.map((waiver) => `  - ${waiver.task_id}: ${waiver.reason}`)
  return [
    heading,
    `completed ${completion.completed_at} by ${completion.completed_by_handle} generation ${completion.completed_by_generation}`,
    completion.summary,
    'Evidence:',
    ...evidence,
    ...(waivers.length ? ['Waivers:', ...waivers] : [])
  ].join('\n')
}
