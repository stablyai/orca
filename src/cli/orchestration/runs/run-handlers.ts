import { abbreviateOrchestrationText } from '../../../shared/orchestration/orchestration-task-summary'
import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getOptionalStringFlagAllowingEmpty,
  getRequiredStringFlag
} from '../../arguments/flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration/orchestration-run-pagination'
import { RuntimeClientError } from '../../runtime/types'
import type { RunRemovedWork } from '../../../shared/orchestration/orchestration-removed-work'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { formatRemovedWorkListing, formatRunRemovedWorkLine } from './removed-work-format'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'
import { withReceiptNext } from '../receipt-next-text'
import {
  findRunOlderRuntimeWillUnbind,
  olderRuntimeUnboundRunNext
} from '../recovery/older-runtime-run-binding'

const RUN_LIST_DEFAULT_LIMIT = 10

/** `none` silences wake pointers, `all` restores every type; otherwise a CSV of message types. */
function notifyTypesFlag(flags: Map<string, string | boolean>): {
  notifyTypes?: string[] | null
} {
  const raw = getOptionalStringFlagAllowingEmpty(flags, 'notify-types')
  if (raw === undefined) {
    return {}
  }
  const value = raw.trim().toLowerCase()
  if (value === 'none') {
    return { notifyTypes: [] }
  }
  if (value === 'all') {
    return { notifyTypes: null }
  }
  const notifyTypes = value
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean)
  if (notifyTypes.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--notify-types needs message types, or `none` / `all`.'
    )
  }
  return { notifyTypes }
}

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const unboundRunId = await findRunOlderRuntimeWillUnbind(client, from).catch(() => null)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
      next?: string
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from,
      ...notifyTypesFlag(flags)
    })
    if (unboundRunId && unboundRunId !== result.result.run.id) {
      result.result.next = olderRuntimeUnboundRunNext(unboundRunId)
    }
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (r) => ({ ...runFields(r.run), next: r.next })
      })
      return
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
      ...notifyTypesFlag(flags),
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, { fields: (r) => runFields(r.run) })
      return
    }
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
      next?: string
    }>('orchestration.runCurrent', { from })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (r) => (r.run ? { ...runFields(r.run), next: r.next } : { runId: null })
      })
      return
    }
    printResult(result, json, (r) =>
      r.run
        ? withReceiptNext(`${r.run.id} ${r.run.objective}`, r)
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
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
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (r) => ({
          runs: r.runs.map((run) => {
            const { runId, ...rest } = runFields(run)
            // Objectives are caller-written and unbounded; --full prints them whole.
            return { id: runId, ...rest, objective: abbreviateOrchestrationText(run.objective) }
          }),
          nextCursor: r.nextCursor ?? undefined
        })
      })
      return
    }
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
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (r) => ({ ...runFields(r.run), removedWork: r.removedWork }),
        text: (_, r) =>
          removed
            ? formatRemovedWorkListing(r.run.id, r.removedWork, cursor)
            : `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}${formatRunRemovedWorkLine(r.run.id, r.removedWork)}`
      })
      return
    }
    printResult(result, json, (r) =>
      removed
        ? formatRemovedWorkListing(r.run.id, r.removedWork, cursor)
        : `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
          `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}` +
          `${formatRunRemovedWorkLine(r.run.id, r.removedWork)}`
    )
  }
}

function runFields(run: {
  id: string
  objective: string
  legacy?: number
  notifyTypes?: string[] | null
}) {
  return {
    runId: run.id,
    objective: run.objective,
    legacy: run.legacy ? true : undefined,
    ...(run.notifyTypes ? { notifyTypes: run.notifyTypes } : {})
  }
}
