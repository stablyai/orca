// Why: the RPC boundary ingests loosely-typed JSON from a CLI that grew
// organically, so these reusable pieces capture the validation shapes that
// recur across domains (optional worktree selector, bounded limit, browser
// target envelope, etc.). Methods compose these to declare their real
// contract without repeating the same `typeof` gymnastics 90 times.
import { z } from 'zod'

// Why: the original handlers treated non-numeric/NaN limit values as "no
// limit" rather than as errors. Preserve that forgiving behavior so CLI
// callers passing stringified numbers or Infinity still reach the runtime.
export const OptionalFiniteNumber = z
  .unknown()
  .transform((value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
  .pipe(z.number().optional())

export const OptionalPositiveInt = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  )
  .pipe(z.number().optional())

export const OptionalString = z
  .unknown()
  .transform((value) => (typeof value === 'string' && value.length > 0 ? value : undefined))
  .pipe(z.string().optional())

export const OptionalPlainString = z
  .unknown()
  .transform((value) => (typeof value === 'string' ? value : undefined))
  .pipe(z.string().optional())

export const OptionalBoolean = z
  .unknown()
  .transform((value) => (typeof value === 'boolean' ? value : undefined))
  .pipe(z.boolean().optional())

// Why: runtime handlers accept `linkedIssue: number | null | undefined` with
// distinct meanings — undefined means "no update", null means "clear", number
// means "set". The ambient JSON decode produces all three shapes as-is.
export const TriStateLinkedIssue = z
  .unknown()
  .transform((value) => {
    if (value === null) {
      return null
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    return undefined
  })
  .pipe(z.union([z.number(), z.null(), z.undefined()]))

// Why: the legacy extractBrowserTarget treated worktree as a plain-string
// passthrough (empty string preserved) but `page` as non-empty-string. The
// browser bridge uses worktree-as-empty-string to mean "any worktree", so
// keep that asymmetry intact to avoid widening scope unexpectedly.
export const BrowserTarget = z.object({
  worktree: OptionalPlainString,
  page: OptionalString
})

export type BrowserTargetInput = z.infer<typeof BrowserTarget>

export function requiredString(message: string) {
  return z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, message))
}

export function requiredNumber(message: string) {
  return z
    .unknown()
    .transform((value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
    )
    .pipe(z.number().refine((v) => Number.isFinite(v), { message }))
}
