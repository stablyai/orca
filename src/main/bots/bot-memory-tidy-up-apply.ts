// Writes a tidy-up's draft or ops: checked against the MEMORY.md the run read, then written onto the
// files as they are now, memory/ first, so a line MEMORY.md loses is always kept somewhere.
import type { BotMemoryChange } from '../../shared/bot-memory-lines'
import type { BotHomeFilesystem } from './bot-home'
import type { BotMemoryRecord } from './bot-memory-record'
import { checkTidyUpOps } from './bot-memory-ops'
import { parseTidyUpOps } from './bot-memory-ops-reply'
import { TIDY_UP_FAILURES, type TidyUpApplied } from './bot-memory-tidy-up'
import {
  checkTidyUpDraft,
  tidyUpChangeFor,
  tidyUpDraft,
  type TidyUpPlan,
  TidyUpRefused,
  tidyUpSummaryOf,
  writeTidyUpFiles
} from './bot-memory-tidy-up-draft'

type ApplyDeps = {
  memory: Pick<BotMemoryRecord, 'change'>
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>
}
type Applied = { error: string; alerted: false } | (TidyUpApplied & { opsFailed?: string })

export async function applyTidyUpDraft(
  deps: ApplyDeps,
  run: { botId: string; folder: string; memory: string; reply: string; today: string }
): Promise<Applied> {
  const draft = tidyUpDraft(run.reply)
  const checked = draft
    ? checkTidyUpDraft(run.memory, draft)
    : { refused: TIDY_UP_FAILURES.noDraft }
  return 'refused' in checked
    ? { error: checked.refused, alerted: false }
    : applyTidyUpPlan(deps, run, checked.plan)
}

/** Ops on `memory` (MEMORY.md as the run's snapshot showed it, after `migration`), applied together
 *  with the migration as one change. An unreadable reply applies only the migration. */
export async function applyTidyUpOps(
  deps: ApplyDeps,
  run: {
    botId: string
    folder: string
    memory: string
    reply: string
    today: string
    ownerWords: readonly (readonly string[])[]
    migration: TidyUpPlan | null
  }
): Promise<Applied> {
  const ops = parseTidyUpOps(run.reply)
  const checked = ops ? checkTidyUpOps(run.memory, ops, run) : null
  const asked = checked?.plan.change
  // No readable reply, or every op skipped: the ops failed, with their first reason, so the run
  // keeps its chats for the next time even when the status move still applies.
  const failed = !checked
    ? TIDY_UP_FAILURES.noOps
    : asked?.added.length === 0 && asked.removed.length === 0 && checked.skipped.length > 0
      ? `${TIDY_UP_FAILURES.allSkipped} (${checked.skipped[0]})`
      : null
  if (failed && !run.migration) {
    return { error: failed, alerted: false }
  }
  const opsFailed = failed && `${TIDY_UP_FAILURES.movedOnly} (${checked?.skipped[0] ?? failed})`
  const plan = joinedPlans(run.migration, failed ? null : (checked?.plan ?? null))
  const applied = await applyTidyUpPlan(deps, run, plan)
  return 'error' in applied
    ? applied
    : { ...applied, skipped: checked?.skipped ?? [], ...(opsFailed ? { opsFailed } : {}) }
}

function joinedPlans(first: TidyUpPlan | null, then: TidyUpPlan | null): TidyUpPlan {
  if (!first || !then) {
    return (first ?? then)!
  }
  const topics = new Map(first.topics)
  for (const [name, lines] of then.topics) {
    topics.set(name, [...(topics.get(name) ?? []), ...lines])
  }
  return {
    ...then,
    change: {
      added: [...first.change.added, ...then.change.added],
      removed: [...first.change.removed, ...then.change.removed]
    },
    topics,
    filed: new Set([...first.filed, ...then.filed]),
    replaced: new Set([...first.replaced, ...then.replaced]),
    groups: new Map([...(first.groups ?? []), ...(then.groups ?? [])])
  }
}

async function applyTidyUpPlan(
  deps: ApplyDeps,
  run: { botId: string; folder: string; today: string },
  plan: TidyUpPlan
): Promise<Applied> {
  const { botId, folder, today } = run
  let asked: BotMemoryChange = { added: [], removed: [] }
  const written = new Map<string, number>()
  try {
    const made = await deps.memory.change(
      botId,
      folder,
      { kind: 'tidy-up' },
      (file) => (asked = tidyUpChangeFor(plan, file)),
      (willMake) => writeTidyUpFiles(deps.fs, folder, plan, willMake, today, written)
    )
    return tidyUpSummaryOf(plan, asked, made, written)
  } catch (error) {
    if (error instanceof TidyUpRefused) {
      return { error: error.message, alerted: false }
    }
    console.warn('[bots] tidy-up could not apply', error)
    return { error: TIDY_UP_FAILURES.notApplied, alerted: false }
  }
}
