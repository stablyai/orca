import type { CommandHandler } from '../../dispatch'
import { printOrchestrationResult } from './agent-view'
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

const RUN_LIST_DEFAULT_LIMIT = 10

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
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: (r) => ({ ...runFields(r.run), next: r.next }),
        fullText: (r) => withReceiptNext(`Run ${r.run.id} created and bound: ${r.run.objective}`, r)
      }
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
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: (r) => runFields(r.run),
        fullText: (r) => `Using Run ${r.run.id}: ${r.run.objective}`
      }
    )
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: (r) => (r.run ? runFields(r.run) : { runId: null }),
        fullText: (r) =>
          r.run
            ? `${r.run.id} ${r.run.objective}`
            : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
      }
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      // A 100-Run first page costs an agent thousands of tokens; --full keeps today's page.
      limit:
        getOptionalPositiveIntegerFlag(flags, 'limit') ??
        (flags.has('full') ? ORCHESTRATION_RUN_PAGE_LIMIT : RUN_LIST_DEFAULT_LIMIT),
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: (r) => ({
          runs: r.runs.map((run) => {
            const { runId, ...rest } = runFields(run)
            return { id: runId, ...rest }
          }),
          nextCursor: r.nextCursor ?? undefined
        }),
        fullText: formatRunList
      }
    )
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
    const runLine = (run: { id: string; objective: string; legacy: number }): string =>
      `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
    printOrchestrationResult(
      result,
      { flags, json },
      {
        fields: (r) => ({ ...runFields(r.run), removedWork: r.removedWork }),
        text: (_, r) =>
          removed
            ? formatRemovedWorkListing(r.run.id, r.removedWork, cursor)
            : runLine(r.run) + formatRunRemovedWorkLine(r.run.id, r.removedWork),
        fullText: (r) =>
          removed
            ? formatRemovedWorkListing(r.run.id, r.removedWork, cursor)
            : `${runLine(r.run)}\n` +
              `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}` +
              `${formatRunRemovedWorkLine(r.run.id, r.removedWork)}`
      }
    )
  }
}

function runFields(run: { id: string; objective: string; legacy?: number }) {
  return { runId: run.id, objective: run.objective, legacy: run.legacy ? true : undefined }
}

function formatRunList(r: {
  runs: { id: string; objective: string; legacy: number }[]
  nextCursor: string | null
}): string {
  const rows =
    r.runs.length === 0
      ? 'No Runs found.'
      : r.runs
          .map((run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`)
          .join('\n')
  return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
}
