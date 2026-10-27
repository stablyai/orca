// Fill unsaved choices from execution evidence, never startup/config reports or host defaults.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-option-intent'
import { savedAgentSessionCatalogModels } from './structured-agent-session-pick-reply'
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'

type RanOptionsContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'agents' | 'modelCatalog'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  now: () => number
}

type RanOptions = Partial<Record<'model' | 'effort', string>>

export type StructuredAgentSessionHandedOptions = {
  message?: AgentSessionExecutionOptions
  executed?: Readonly<Record<string, string>>
}

/** Per-child reports and a handed-over turn awaiting its first model evidence. */
const childRuns = new WeakMap<
  StructuredAgentSessionProviderChild,
  { reported?: RanOptions; owed?: StructuredAgentSessionHandedOptions; permission?: string | null }
>()

function currentChild(context: RanOptionsContext, sessionId: string, fence: number) {
  const child = context.sessions.get(sessionId)?.child
  return child?.fence === fence ? child : null
}

export function structuredAgentSessionChildRan(
  child: StructuredAgentSessionProviderChild
): RanOptions | undefined {
  return childRuns.get(child)?.reported
}

/** The current child's startup report or applied evidence; never saved intent or send authority. */
export function structuredAgentSessionRuntimePermission(
  child: StructuredAgentSessionProviderChild | undefined
): { fence: number; mode: string | null } | null {
  const mode = child && childRuns.get(child)?.permission
  return child?.phase === 'ready' && mode !== undefined ? { fence: child.fence, mode } : null
}

export function noteStructuredAgentSessionRuntimePermission(
  child: StructuredAgentSessionProviderChild,
  reported: AgentSessionOptionsResult['current'],
  initial = false
): void {
  const previous = childRuns.get(child)
  if (
    reported.reportedPermissionMode !== undefined &&
    (!initial || previous?.permission === undefined)
  ) {
    childRuns.set(child, { ...previous, permission: reported.reportedPermissionMode })
  }
}

function reportedRan(reported: AgentSessionOptionsResult['current']): RanOptions | null {
  const { model, effort } = reported
  const filled = reported.defaulted ?? []
  if (!model || model === 'default' || filled.includes('model')) {
    return null
  }
  return { model, ...(effort && !filled.includes('effort') ? { effort } : {}) }
}

/** Resolve delayed model evidence for an already handed-over turn. */
export async function noteStructuredAgentSessionReportedOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  reported: AgentSessionOptionsResult['current']
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const ran = reportedRan(reported)
  if (!child || !ran) {
    return
  }
  const runs = childRuns.get(child)
  childRuns.set(child, { ...runs, reported: ran })
  if (runs?.owed && ran.model) {
    const owed = runs.owed
    await recordStructuredAgentSessionRanOptions(context, sessionId, fence, {
      ...owed,
      executed: { ...owed.executed, model: ran.model }
    })
  }
}

export type StructuredAgentSessionRanRecorder = (
  sessionId: string,
  fence: number
) => ((handed: StructuredAgentSessionHandedOptions) => Promise<void>) & {
  prepareInput?: () => void
  checkpoint?: () => void
}

/** Capture report identity at input to preserve early reports and avoid stale fallbacks. */
export function createStructuredAgentSessionRanRecorder(
  context: RanOptionsContext,
  sessionId: string,
  fence: number
): ReturnType<StructuredAgentSessionRanRecorder> {
  let checkpoint: { reported?: RanOptions } | undefined
  return Object.assign(
    (handed: StructuredAgentSessionHandedOptions) =>
      recordStructuredAgentSessionRanOptions(context, sessionId, fence, handed, checkpoint),
    {
      prepareInput: () => {
        const child = currentChild(context, sessionId, fence)
        if (child) {
          delete childRuns.get(child)?.owed
        }
      },
      checkpoint: () => {
        const child = currentChild(context, sessionId, fence)
        checkpoint = { reported: child ? childRuns.get(child)?.reported : undefined }
      }
    }
  )
}

/** Post-handover bookkeeping failures log without refusing the send. */
export async function recordStructuredAgentSessionRanOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  handed: StructuredAgentSessionHandedOptions,
  checkpoint?: { reported?: RanOptions }
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const { store, logger, agents } = context.deps
  const record = store.getRecord(sessionId)
  if (!child || !record) {
    return
  }
  const { message, executed } = handed
  const reported = childRuns.get(child)?.reported
  // A report only completes an agent's own evidence of the dispatch, never stands in for it.
  const newerModel = checkpoint && reported !== checkpoint.reported ? reported?.model : undefined
  const model = executed ? (executed.model ?? message?.model ?? newerModel) : message?.model
  childRuns.set(child, { ...childRuns.get(child), owed: executed && !model ? handed : undefined })
  if (!model) {
    return
  }
  // Prefer dispatch proof, else the message's effort; its tier or Fast may not have run.
  const proposed: Readonly<Record<string, string | undefined>> = executed ?? {
    effort: message?.effort
  }
  const ran: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...proposed, model })) {
    // Persist only choices the agent can accept on future sends.
    if (
      value &&
      !structuredAgentSessionOptionOverridesRefusal(agents, record.provider, { [key]: value })
    ) {
      ran[key] = value
    }
  }
  if (!ran.model) {
    return
  }
  const models = await savedAgentSessionCatalogModels(context.deps, record.provider, sessionId)
  await store
    .reviseSessionOptions(recordAgentSessionRanOptions, {
      sessionId,
      fence: child.fence,
      model,
      options: ran,
      models,
      now: context.now()
    })
    .catch((error: unknown) =>
      logger.warn('recording the options a turn ran failed', {
        scope: 'ran-options',
        sessionId,
        error
      })
    )
}
