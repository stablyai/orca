import type { BridgedParityClass } from './divergence-classes'

// Share drift semantics across closure tables so inherited goldens cannot receive inconsistent verdicts by domain.

export type StrictBridgedVerdict = BridgedParityClass | 'identical'
export type BridgedParityVerdict = StrictBridgedVerdict | { verdict: 'bridge-contract' }

export function verdictName(value: BridgedParityVerdict): string {
  return typeof value === 'string' ? value : value.verdict
}
export function sameVerdict(left: BridgedParityVerdict, right: BridgedParityVerdict): boolean {
  return typeof left === 'string' || typeof right === 'string'
    ? left === right
    : left.verdict === right.verdict
}

export type PageClosureObservation = {
  family: string
  verdict: BridgedParityVerdict
  domain?: 'paired' | 'bridge-only'
}

export type PageClosurePins = Readonly<
  Record<string, Readonly<Record<string, BridgedParityVerdict>>>
>

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
    const arrived = seen.filter((id) => !Object.hasOwn(pins, id))
    const left = Object.keys(pins).filter((id) => !seen.includes(id))
    if (arrived.length > 0 || left.length > 0) {
      drift.push(
        `${family}: arrived ${arrived.join(', ') || '(none)'}; left ${left.join(', ') || '(none)'}`
      )
    }
    for (const [id, verdict] of Object.entries(pins)) {
      const ran = observed.get(id)?.verdict
      if (ran !== undefined && !sameVerdict(ran, verdict)) {
        drift.push(`${id}: pinned ${JSON.stringify(verdict)}, ran ${JSON.stringify(ran)}`)
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
    ...diverged.map(([id, seen]) => `  ${id}: ${JSON.stringify(seen.verdict)}\n`)
  ].join('')
}
