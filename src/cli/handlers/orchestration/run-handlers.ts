import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import type { RunRemovedWork } from '../../../shared/orchestration-removed-work'
import { callOrchestrationMutation } from './mutation-request'
import { formatRemovedWorkListing, formatRunRemovedWorkLine } from './removed-work-format'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { withReceiptNext } from './receipt-next-text'
import {
  findRunOlderRuntimeWillUnbind,
  olderRuntimeUnboundRunNext
} from './older-runtime-run-binding'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const unboundRunId = await findRunOlderRuntimeWillUnbind(client, from).catch(() => null)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
      next?: string
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from
    })
    if (unboundRunId && unboundRunId !== result.result.run.id) {
      result.result.next = olderRuntimeUnboundRunNext(unboundRunId)
    }
    printResult(result, json, (r) =>
      withReceiptNext(`Run ${r.run.id} created and bound: ${r.run.objective}`, r)
    )
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
      r.run
        ? `${r.run.id} ${r.run.objective}`
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
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
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const cursor = getOptionalStringFlag(flags, 'cursor')
    const removed = flags.has('removed') || cursor !== undefined
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
      removedWork?: RunRemovedWork
    }>('orchestration.runShow', {
      id: getRequiredStringFlag(flags, 'id'),
      ...(removed ? { removed: true } : {}),
      ...(cursor ? { cursor } : {})
    })
    printResult(result, json, (r) =>
      removed
        ? formatRemovedWorkListing(r.run.id, r.removedWork, cursor)
        : `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
          `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}` +
          `${formatRunRemovedWorkLine(r.run.id, r.removedWork)}`
    )
  }
}
