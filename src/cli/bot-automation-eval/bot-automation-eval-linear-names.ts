// The stand-in's Linear names: the cloud's own matching (linear-issue-names.ts), over the world's
// lists in place of Linear's lookups; bot-automation-eval-linear.test.ts holds them to its recordings.
import {
  foldLinearName,
  linearNamed
} from '../../../cloud/packages/connector-contract/src/linear-issue-names'

export type Refused = { ok: false; refusal: string; message: string }

export const refuse = (refusal: string, message: string): Refused => ({
  ok: false,
  refusal,
  message
})

// As linear-names.ts lookUp: Linear finds those a name names whole, else those it starts.
export function lookUp<T extends { name: string }>(
  kind: string,
  candidates: readonly T[],
  wanted: string,
  namesOf: (candidate: T) => readonly string[] = (candidate) => [candidate.name]
): T[] | Refused {
  const want = foldLinearName(wanted)
  for (const match of [(name: string) => name === want, (name: string) => name.startsWith(want)]) {
    const found = candidates.filter((candidate) =>
      namesOf(candidate).some((name) => match(foldLinearName(name)))
    )
    if (found.length > 0) {
      return linearNamed(kind, found, wanted, namesOf)
    }
  }
  return refuse('not_found', `No ${kind} is named "${wanted}".`)
}
