import type { BridgedParityClass } from './divergence-classes'

// Share drift semantics across closure tables so inherited goldens cannot receive inconsistent verdicts by domain.

export type BridgedParityVerdict = BridgedParityClass | 'identical'

export type PageClosureObservation = {
  family: string
  verdict: BridgedParityVerdict
}

export type PageClosurePins = Readonly<
  Record<string, Readonly<Record<string, BridgedParityVerdict>>>
>

export function pageClosureExclusions(
  pinned: PageClosurePins
): readonly (readonly [string, BridgedParityClass])[] {
  return Object.values(pinned).flatMap((family) =>
    Object.entries(family).flatMap(([id, verdict]) =>
      verdict === 'identical' ? [] : [[id, verdict] as const]
    )
  )
}

// Independent class totals catch self-consistent table derivation errors that per-id agreement misses.
export function pageClosureTotals(pinned: PageClosurePins): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {}
  for (const family of Object.values(pinned)) {
    for (const verdict of Object.values(family)) {
      totals[verdict] = (totals[verdict] ?? 0) + 1
    }
  }
  return totals
}

// Compare family membership as well as verdicts so newly reached goldens cannot evade a table that never named them.
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

export function pageClosureRunTotals(
  pinned: PageClosurePins,
  observed: ReadonlyMap<string, PageClosureObservation>
): Readonly<Record<string, number>> {
  const ran: Record<string, number> = {}
  for (const [, seen] of observed) {
    if (seen.family in pinned) {
      ran[seen.verdict] = (ran[seen.verdict] ?? 0) + 1
    }
  }
  return ran
}
