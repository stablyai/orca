// Writes a tidy-up's draft or ops: checked against the MEMORY.md the run read, then written onto the
// files as they are now, memory/ first, so a line MEMORY.md loses is always kept somewhere.
import type { BotMemoryChange, BotMemoryLine } from '../../shared/bot-memory-lines'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import type { BotHomeFilesystem } from './bot-home'
import type { BotMemoryRecord } from './bot-memory-record'
import { checkTidyUpOps, TIDY_UP_KEEP_SKIP } from './bot-memory-ops'
import type { BotSalvageStore } from './bot-memory-salvage-store'
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

const looksSecret = ({ line, after }: BotMemoryLine): boolean =>
  redactSecretLike(line) !== line || (after !== null && redactSecretLike(after) !== after)

type ApplyDeps = {
  memory: Pick<BotMemoryRecord, 'change'>
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>
  /** Told which lines the status move took, once they are in the journal. */
  salvage?: Pick<BotSalvageStore, 'recordMoved'>
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
    migration: TidyUpPlan | null
    exempt?: (text: string) => boolean
  }
): Promise<Applied> {
  const ops = parseTidyUpOps(run.reply)
  const checked = ops ? checkTidyUpOps(run.memory, ops, run.exempt) : null
  const asked = checked?.plan.change
  // No readable reply, or every op skipped: the ops failed, with their first reason, so the run
  // keeps its chats for the next time even when the status move still applies.
  // A skip only because the line reads as the owner's decision is the guard working, not a failure.
  const realSkips = checked?.skipped.filter((why) => !why.endsWith(TIDY_UP_KEEP_SKIP)) ?? []
  const failed = !checked
    ? TIDY_UP_FAILURES.noOps
    : asked?.added.length === 0 && asked.removed.length === 0 && realSkips.length > 0
      ? `${TIDY_UP_FAILURES.allSkipped} (${realSkips[0]})`
      : null
  if (failed && !run.migration) {
    return { error: failed, alerted: false }
  }
  const opsFailed = failed && `${TIDY_UP_FAILURES.movedOnly} (${checked?.skipped[0] ?? failed})`
  const plan = joinedPlans(run.migration, failed ? null : (checked?.plan ?? null))
  const applied = await applyTidyUpPlan(deps, run, plan, run.migration)
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
  plan: TidyUpPlan,
  migration: TidyUpPlan | null = null
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
      async (willMake) => {
        // What the file will really lose, with the anchors History stores from it: a secret-looking
        // one (added since the run read the file) would make the row non-undoable, so refuse.
        if (plan.groups && willMake.removed.some(looksSecret)) {
          throw new TidyUpRefused(TIDY_UP_FAILURES.changed)
        }
        await writeTidyUpFiles(deps.fs, folder, plan, willMake, today, written)
      }
    )
    if (migration) {
      await recordMoved(deps, run, migration, made)
    }
    return tidyUpSummaryOf(plan, asked, made, written)
  } catch (error) {
    if (error instanceof TidyUpRefused) {
      return { error: error.message, alerted: false }
    }
    console.warn('[bots] tidy-up could not apply', error)
    return { error: TIDY_UP_FAILURES.notApplied, alerted: false }
  }
}

/** The status move's lines MEMORY.md really lost, which the journal now holds, for salvage. A
 *  record that fails leaves those lines unoffered, never the tidy-up undone. */
async function recordMoved(
  deps: ApplyDeps,
  run: { botId: string; today: string },
  migration: TidyUpPlan,
  made: BotMemoryChange
): Promise<void> {
  const moved = new Set(migration.change.removed.map(({ line }) => line.trimEnd()))
  const lines = made.removed.map(({ line }) => line.trimEnd()).filter((line) => moved.has(line))
  if (lines.length === 0 || !deps.salvage) {
    return
  }
  try {
    await deps.salvage.recordMoved(run.botId, run.today.slice(0, 7), lines, Date.now())
  } catch (error) {
    console.warn('[bots] salvage could not record moved lines', error)
  }
}
