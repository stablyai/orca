// One salvage pass for a bot in the memory pilot: sorts newly moved lines, settles an open proposal
// from its owner's answer (or its age), and makes the next proposal when one is due. Only Orca
// writes here: the bot is never asked to restore anything, and no model reads the answer.
import type { BotItemAsk } from '../../shared/bots/bot-item-ask'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import {
  parseSalvageAnswer,
  SALVAGE,
  salvageCandidateTest,
  salvageLineDate,
  salvageSupersededBy
} from './bot-memory-salvage'
import {
  type BotSalvage,
  type BotSalvageStore,
  type SalvageProposal,
  type SalvageSource,
  salvageNextProposal
} from './bot-memory-salvage-store'
import { SALVAGE_NOTES, SALVAGE_REASK, salvageProposalText } from './bot-memory-salvage-text'

/** Non-candidates are never offered, so after this long they are dropped from the record. */
const NON_CANDIDATE_KEPT_MS = 180 * 86_400_000

export type SalvageOfferDeps = {
  store: Pick<BotSalvageStore, 'get' | 'update'>
  items: {
    /** Orca's item asking the owner; null when the bot has no chat to put it in. */
    ask: (
      botId: string,
      text: { title: string; description: string; ask: BotItemAsk }
    ) => Promise<{ uid: string; number: number; question: number } | null>
    /** Asks again; the new question's event. */
    reask: (uid: string, ask: BotItemAsk) => Promise<number>
    close: (uid: string, to: 'done' | 'canceled', note: string) => Promise<void>
    status: (uid: string) => Promise<BotItemStatus | null>
    /** The owner's comments after event `after`, oldest first. */
    ownerComments: (uid: string, after: number) => Promise<{ id: number; text: string }[]>
  }
  /** Every line of the bot's memory/journal/ files, by month. */
  journal: (botId: string) => Promise<Map<string, string[]>>
  /** Adds `line` to MEMORY.md word for word, unless a line with its words is already there. */
  restore: (
    botId: string,
    line: string,
    origin: { month: string; item: number }
  ) => Promise<'kept' | 'kept-already-present'>
  ownerNames: () => Promise<string[]>
  now: () => number
}

type States = Record<string, Pick<SalvageSource, 'state' | 'expiries'>>

const withStates = (before: BotSalvage, states: States): BotSalvage => {
  const sources = { ...before.sources }
  for (const [hash, change] of Object.entries(states)) {
    if (sources[hash]) {
      sources[hash] = { ...sources[hash], ...change }
    }
  }
  return { ...before, sources }
}

/** A line a restore could write: one line, short, nothing secret-looking. */
function restorable(line: string): boolean {
  return line.length <= SALVAGE.lineChars && !line.includes('\n') && redactSecretLike(line) === line
}

export async function salvageOffer(botId: string, deps: SalvageOfferDeps): Promise<void> {
  const isCandidate = salvageCandidateTest(await deps.ownerNames())
  const now = deps.now()
  await deps.store.update(botId, (before) => {
    const sources: BotSalvage['sources'] = {}
    let changed = false
    for (const [hash, source] of Object.entries(before.sources)) {
      if (source.state === 'non-candidate' && now - source.movedAt > NON_CANDIDATE_KEPT_MS) {
        changed = true
        continue
      }
      if (source.state !== 'moved') {
        sources[hash] = source
        continue
      }
      changed = true
      const state = !isCandidate(source.line)
        ? 'non-candidate'
        : restorable(source.line)
          ? 'candidate'
          : 'unrestorable'
      sources[hash] = { ...source, state }
    }
    return changed ? { ...before, sources } : before
  })
  const open = (await deps.store.get(botId)).proposal
  if (open) {
    await settle(botId, open, deps)
  }
  const salvage = await deps.store.get(botId)
  if (!salvage.proposal && deps.now() - salvage.lastProposalAt >= SALVAGE.everyMs) {
    await propose(botId, salvage, deps)
  }
}

async function propose(botId: string, salvage: BotSalvage, deps: SalvageOfferDeps): Promise<void> {
  const hashes = salvageNextProposal(salvage)
  if (hashes.length === 0) {
    return
  }
  const journal = await deps.journal(botId)
  const lines = [...journal.values()].flat().map((line) => ({ line, date: salvageLineDate(line) }))
  const offered = hashes.map((hash) => {
    const { line, month } = salvage.sources[hash]!
    const replacedBy = salvageSupersededBy({ line, date: salvageLineDate(line) }, lines)
    return { line, month, replacedBy }
  })
  const made = await deps.items.ask(botId, salvageProposalText(offered))
  if (!made) {
    return
  }
  const at = deps.now()
  await deps.store.update(botId, (before) => ({
    ...withStates(
      before,
      Object.fromEntries(
        hashes.map((hash) => [
          hash,
          { state: 'proposed' as const, expiries: before.sources[hash]?.expiries ?? 0 }
        ])
      )
    ),
    proposal: { ...made, hashes, at, reasked: false },
    lastProposalAt: at
  }))
}

/** Reads the owner's answer, or ends a proposal no one answered. */
async function settle(botId: string, proposal: SalvageProposal, deps: SalvageOfferDeps) {
  const listed =
    (state: 'declined' | 'candidate' | 'expired', bump = 0) =>
    (before: BotSalvage) =>
      withStates(
        { ...before, proposal: null },
        Object.fromEntries(
          proposal.hashes.map((hash) => {
            const expiries = (before.sources[hash]?.expiries ?? 0) + bump
            return [hash, { state, expiries }]
          })
        )
      )
  const status = await deps.items.status(proposal.uid)
  if (status === null) {
    // The item is gone: offered again, as if never asked.
    return deps.store.update(botId, listed('candidate'))
  }
  const comments = await deps.items.ownerComments(proposal.uid, proposal.question)
  for (const { text } of comments) {
    const kept = parseSalvageAnswer(text, proposal.hashes.length)
    if (kept !== null) {
      return keep(botId, proposal, new Set(kept), status, deps)
    }
  }
  if (status === 'done' || status === 'canceled') {
    // Closed by the owner without an answer Orca can read: nothing kept.
    return deps.store.update(botId, listed('declined'))
  }
  if (comments.length > 0) {
    if (!proposal.reasked) {
      const question = await deps.items.reask(proposal.uid, SALVAGE_REASK)
      return deps.store.update(botId, (before) => ({
        ...before,
        proposal: { ...proposal, question, reasked: true }
      }))
    }
    await deps.items.close(proposal.uid, 'canceled', SALVAGE_NOTES.unread)
    return deps.store.update(botId, listed('declined'))
  }
  if (deps.now() - proposal.at >= SALVAGE.expiresMs) {
    await deps.items.close(proposal.uid, 'canceled', SALVAGE_NOTES.expired)
    return deps.store.update(botId, listed('expired', 1))
  }
}

/** Puts back the chosen lines, each first in MEMORY.md and then in the record, so a pass cut off
 *  between the two finds the line there and only marks it. The item closes once every chosen line
 *  is settled; one that failed is tried again on the next pass. */
async function keep(
  botId: string,
  proposal: SalvageProposal,
  chosen: ReadonlySet<number>,
  status: BotItemStatus,
  deps: SalvageOfferDeps
): Promise<void> {
  const { sources } = await deps.store.get(botId)
  const journal = await deps.journal(botId)
  const states: States = {}
  let pending = 0
  for (const [index, hash] of proposal.hashes.entries()) {
    const source = sources[hash]
    if (!source || source.state !== 'proposed') {
      continue
    }
    const { expiries } = source
    if (!chosen.has(index + 1)) {
      states[hash] = { state: 'declined', expiries }
      continue
    }
    const inJournal = (journal.get(source.month) ?? []).some((l) => l.trimEnd() === source.line)
    if (!inJournal || !restorable(source.line)) {
      states[hash] = { state: 'unrestorable', expiries }
      continue
    }
    try {
      const origin = { month: source.month, item: proposal.number }
      states[hash] = { state: await deps.restore(botId, source.line, origin), expiries }
    } catch (error) {
      console.warn('[bots] salvage could not put a line back', error)
      pending++
    }
  }
  await deps.store.update(botId, (before) => withStates(before, states))
  if (pending > 0) {
    return
  }
  // Counted from the record, so lines a cut-off pass already kept are counted too.
  const after = (await deps.store.get(botId)).sources
  const count = (...wanted: SalvageSource['state'][]) =>
    proposal.hashes.filter((hash) => wanted.includes(after[hash]?.state ?? 'moved')).length
  if (status !== 'done' && status !== 'canceled') {
    const note = SALVAGE_NOTES.kept(count('kept', 'kept-already-present'), count('unrestorable'))
    await deps.items.close(proposal.uid, 'done', note)
  }
  await deps.store.update(botId, (before) => ({ ...before, proposal: null }))
}
