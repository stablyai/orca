import type { BridgedParityClass } from './divergence-classes'

/**
 * What a domain's page closure pins, and how a run is read against it.
 *
 * One semantics for every series. C1 and C5 each pinned their own goldens with their own copy of
 * these four helpers, identical but for the names, and the copies are the problem rather than the
 * duplication: the pins are the instrument two domains argue about when a golden moves between
 * families they share, and two spellings of "what drifted" can disagree about the answer while both
 * stay green. C5's closure contains C1's 22 families entire, so they read the same goldens.
 *
 * The table itself stays per series. That is the evidence each series certified, and it is meant to
 * be read as a diff when it changes.
 */

/** Byte-identical, or the class that named the divergence. */
export type BridgedParityVerdict = BridgedParityClass | 'identical'

/** One golden's verdict in a run, and the family the corpus records it under. */
export type PageClosureObservation = {
  family: string
  verdict: BridgedParityVerdict
}

/** A domain's pinned goldens: family, then golden, then the verdict it gives. */
export type PageClosurePins = Readonly<
  Record<string, Readonly<Record<string, BridgedParityVerdict>>>
>

/** Every closure golden that did not replay byte-identically, which the suite prints beside why. */
export function pageClosureExclusions(
  pinned: PageClosurePins
): readonly (readonly [string, BridgedParityClass])[] {
  return Object.values(pinned).flatMap((family) =>
    Object.entries(family).flatMap(([id, verdict]) =>
      verdict === 'identical' ? [] : [[id, verdict] as const]
    )
  )
}

/**
 * How many goldens a closure pins in each class, which a per-id walk cannot see move.
 *
 * A walk that compares each id to its own verdict agrees with a table built wrong in a way that is
 * self-consistent. Deriving C5's file with a reader that skipped `c1-page-closure.ts`'s wrapped
 * entries produced exactly that: every pin it read agreed, the drift came back empty, and three
 * `result-absent-stream-release` goldens had become `result-absent-settlement`.
 */
export function pageClosureTotals(pinned: PageClosurePins): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {}
  for (const family of Object.values(pinned)) {
    for (const verdict of Object.values(family)) {
      totals[verdict] = (totals[verdict] ?? 0) + 1
    }
  }
  return totals
}

/**
 * Each closure family whose goldens or verdicts are not the ones pinned, said in one line.
 *
 * Membership is checked per family rather than against the flat id list, so a golden newly derived
 * into a family a domain owns arrives as a finding instead of going unnoticed for being absent from
 * a pin that never mentioned it.
 */
export function pageClosureDrift(
  pinned: PageClosurePins,
  observed: ReadonlyMap<string, PageClosureObservation>
): readonly string[] {
  const byFamily = new Map<string, string[]>()
  for (const [id, { family }] of observed) {
    byFamily.set(family, [...(byFamily.get(family) ?? []), id])
  }
  const drift: string[] = []
  for (const [family, pins] of Object.entries(pinned)) {
    const seen = byFamily.get(family) ?? []
    const arrived = seen.filter((id) => !(id in pins))
    const left = Object.keys(pins).filter((id) => !seen.includes(id))
    if (arrived.length > 0 || left.length > 0) {
      drift.push(
        `${family}: arrived ${arrived.join(', ') || '(none)'}; left ${left.join(', ') || '(none)'}`
      )
    }
    for (const [id, verdict] of Object.entries(pins)) {
      const ran = observed.get(id)?.verdict
      if (ran !== undefined && ran !== verdict) {
        drift.push(`${id}: pinned ${verdict}, ran ${ran}`)
      }
    }
  }
  return drift
}

/** One domain's closure as the gate reports it: the line it prints and the goldens that diverged. */
export function readPageClosure(
  name: string,
  pinned: PageClosurePins,
  observed: ReadonlyMap<string, PageClosureObservation>
): string {
  const closure = [...observed].filter(([, seen]) => seen.family in pinned)
  const diverged = closure.filter(([, seen]) => seen.verdict !== 'identical')
  return [
    `\n${name} page closure: ${closure.length} goldens in ${Object.keys(pinned).length} families, ${
      closure.length - diverged.length
    } byte-identical\n`,
    ...diverged.map(([id, seen]) => `  ${id}: ${seen.verdict}\n`)
  ].join('')
}
