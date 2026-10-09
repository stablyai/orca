// Picks made while a child started are the conversation's intent, recorded at once and never a
// provider write the pick waits on. The child launched with the options saved when its start
// began; whatever the record holds now that differs is applied before the start is accepted, model
// before effort, since an effort is only valid for the model it is set on. A pick the child refuses
// is shown as what it runs; one cut short leaves the start unproven, so the child never runs it.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionOptionRevisions } from './structured-agent-session-option-revisions'

const APPLY_ORDER = ['model', 'effort']

function applyRank(key: string): number {
  const rank = APPLY_ORDER.indexOf(key)
  return rank === -1 ? APPLY_ORDER.length : rank
}

/** Each saved value the child did not launch with, in the order a provider can take them. */
export function structuredAgentSessionStartupIntentWrites(
  launched: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, string>> | undefined
): [key: string, value: string][] {
  return Object.entries(saved ?? {})
    .filter(([key, value]) => launched[key] !== value)
    .sort(([a], [b]) => applyRank(a) - applyRank(b))
}

/** What applying the intent came to: `aborted` when a close, Stop, quit or the startup limit cut
 *  it short, which leaves the start unproven; otherwise the keys the child refused. */
export type StructuredAgentSessionStartupIntentOutcome = {
  aborted: boolean
  failed: string[]
}

/** Applies the intent, each write under the start's own abort (the startup limit included). A write
 *  that fails is reported and its key returned, never blocking the start. */
export async function applyStructuredAgentSessionStartupIntent(
  context: {
    deps: Pick<StructuredAgentSessionHostDeps, 'adapter' | 'store' | 'logger'>
    acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
    optionRevisions: Pick<StructuredAgentSessionOptionRevisions, 'advance'>
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity,
  launched: Readonly<Record<string, string>>
): Promise<StructuredAgentSessionStartupIntentOutcome> {
  const writes = structuredAgentSessionStartupIntentWrites(
    launched,
    context.deps.store.getRecord(sessionId)?.options
  )
  const failed: string[] = []
  if (writes.length === 0) {
    return { aborted: false, failed }
  }
  const wait = context.acquireAborts.begin(sessionId)
  try {
    for (const [key, value] of writes) {
      if (wait.signal.aborted) {
        break
      }
      try {
        await context.deps.adapter.setOption({
          sessionId,
          key,
          value,
          fence: child.fence,
          signal: wait.signal
        })
      } catch (error) {
        failed.push(key)
        context.deps.logger.warn('applying a pick made while the agent started failed', {
          scope: 'startup-intent',
          sessionId,
          key,
          error
        })
      } finally {
        // As a ready child's pick: whatever the write's outcome, a report read before it is stale.
        context.optionRevisions.advance(sessionId)
      }
    }
    return { aborted: wait.signal.aborted, failed }
  } finally {
    wait.end()
  }
}

/** A pick the child refused is shown as what the child runs, never left showing a value it does
 *  not: what it reported, else what it launched with. Bookkeeping: a failed write is reported. */
export async function revertRefusedStartupIntent(
  context: {
    deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>
    now: () => number
  },
  input: {
    sessionId: string
    fence: number
    refused: readonly string[]
    launched: Readonly<Record<string, string>>
    reported: AgentSessionOptionsResult['current']
  }
): Promise<void> {
  const { store, logger } = context.deps
  const record = store.getRecord(input.sessionId)
  if (input.refused.length === 0 || !record) {
    return
  }
  const running = nativeSessionOptionsFromReport({ reported: input.reported, restoreSkipped: [] })
  const options: Record<string, string> = { ...record.options }
  for (const key of input.refused) {
    const value = running[key] ?? input.launched[key]
    if (value === undefined) {
      delete options[key]
    } else {
      options[key] = value
    }
  }
  try {
    await store.replaceSessionOptions({
      sessionId: input.sessionId,
      fence: input.fence,
      options,
      now: context.now()
    })
  } catch (error) {
    logger.warn('showing what the agent runs after it refused a pick failed', {
      scope: 'startup-intent',
      sessionId: input.sessionId,
      error
    })
  }
}
