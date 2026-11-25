import { createHash } from 'node:crypto'

// A bot's Linear fields as Linear reads them: the cloud's find, set and create read names and priorities
// here, and the host's eval stand-in reads them the same way.

export type LinearNameRefusal = { ok: false; refusal: 'ambiguous' | 'not_found' | 'invalid_args'; message: string }

const refuse = (refusal: LinearNameRefusal['refusal'], message: string): LinearNameRefusal => ({
  ok: false,
  refusal,
  message
})

// Linear's priority numbers by name.
export const LINEAR_PRIORITY_NUMBERS = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 } as const

// Names a refusal lists so the bot can pick one.
const MAX_LISTED = 10

export const foldLinearName = (name: string) => name.trim().toLowerCase()

// Each name once, as first written, however it is cased.
const distinctNames = (named: readonly { name: string }[]) =>
  named
    .filter((entry, at) => named.findIndex((other) => foldLinearName(other.name) === foldLinearName(entry.name)) === at)
    .map((entry) => entry.name)

/**
 * Every candidate a name means: those it names whole (by any of their names), else those it starts, as
 * long as they all share one name (a state of that name in each team). Anything else is refused, listing
 * what it could mean.
 */
export function linearNamed<T extends { name: string }>(
  kind: string,
  candidates: readonly T[],
  wanted: string,
  namesOf: (candidate: T) => readonly string[] = (candidate) => [candidate.name]
): T[] | LinearNameRefusal {
  const want = foldLinearName(wanted)
  const named = (match: (name: string) => boolean) =>
    candidates.filter((candidate) => namesOf(candidate).some((name) => match(foldLinearName(name))))
  const whole = named((name) => name === want)
  const matched = whole.length > 0 ? whole : named((name) => name.startsWith(want))
  const names = distinctNames(matched)
  if (names.length === 1) {
    return matched
  }
  const listed = (names.length > 0 ? names : distinctNames(candidates)).slice(0, MAX_LISTED)
  return names.length > 1
    ? refuse('ambiguous', `"${wanted}" could be more than one ${kind}: ${listed.join(', ')}. Pass the whole name.`)
    : refuse('not_found', `No ${kind} is named "${wanted}"${listed.length > 0 ? `; there are: ${listed.join(', ')}` : ''}.`)
}

/** Exactly one, where what a name means must be a single thing (a person, a team's label or state). */
export function onlyOneLinearNamed<T, R extends { ok: false }>(kind: string, wanted: string, found: T[] | R): T | R | LinearNameRefusal {
  if (!Array.isArray(found)) {
    return found
  }
  const [only, ...others] = found
  return only !== undefined && others.length === 0
    ? only
    : refuse('ambiguous', `More than one ${kind} is named "${wanted}"; Linear can't tell them apart by name.`)
}

/** A refusal when a label is both added and removed, which Linear can't do at once. */
export function linearLabelsClash(
  addLabels: readonly string[] | undefined,
  removeLabels: readonly string[] | undefined
): LinearNameRefusal | null {
  const both = addLabels?.find((name) => removeLabels?.some((other) => foldLinearName(other) === foldLinearName(name)))
  return both ? refuse('invalid_args', `"${both}" is both added and removed; name it once.`) : null
}

/** The id a new issue gets from its post's retry key: the same post always names the same issue. */
export function linearIssueIdFor(key: string): string {
  const hex = createHash('sha256').update(`orca-linear-create:${key}`).digest('hex')
  // A version 4 shape with the variant bits set, as Linear takes an id.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
