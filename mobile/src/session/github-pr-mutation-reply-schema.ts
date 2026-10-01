import { z } from 'zod'

// The two reply contracts the `github.*` PR mutation surface uses. Checked against
// GitHubProjectMutationResult / GitHubCommentResult in src/shared/github/project-result-types.ts
// and comment-types.ts for the status envelope, and against updatePRTitle /
// resolveReviewThread in src/main/github/client/update/, both `Promise<boolean>`, for the
// confirmation.

/**
 * What a PR mutation reported in-band. `structured: false` is the host returning void or a bare
 * value with no `ok` member, which every caller has always read as success.
 */
export type GitHubPrMutationStatus =
  | { readonly structured: false }
  | { readonly structured: true; readonly ok: unknown; readonly error: unknown }

/**
 * The status envelope.
 *
 * `ok` is a bare `z.unknown()`, which zod 4 treats as required — that is exactly main's
 * `'ok' in raw` test, and it is the whole discriminant. Neither `ok` nor `error` is typed:
 * github-pr-mutation-outcome.ts:60 compares `ok` to `true` and :15-26 reads `error` as a string or
 * an object with a `message`, both fully guarded, so narrowing either would refuse a reply the
 * caller already handles.
 */
const mutationStatusEnvelopeSchema = z
  .looseObject({ ok: z.unknown(), error: z.unknown().optional() })
  .transform((reply): GitHubPrMutationStatus => ({
    structured: true,
    ok: reply.ok,
    error: reply.error
  }))

/**
 * Everything else, which is a success with nothing to report.
 *
 * Deliberately `z.unknown()`: main read a void reply, a bare string and an array alike as an
 * unstructured success, and a mutation the host accepted must not become an error because its
 * body was shaped differently. The envelope arm is declared first so a reply carrying `ok` is
 * read as the status it is.
 */
const mutationVoidSchema = z
  .unknown()
  .transform((): GitHubPrMutationStatus => ({ structured: false }))

export const githubPrMutationStatusSchemas = [
  mutationStatusEnvelopeSchema,
  mutationVoidSchema
] as const

/**
 * The two mutations whose host result is a bare boolean.
 *
 * `z.boolean()` rather than a passthrough, because `=== true` is the caller's confirmation rule
 * (github-pr-mutation-outcome.ts:93) and a non-boolean silently read as "not confirmed" — the same
 * outcome a real `false` gets, so a host whose reply shape drifted was indistinguishable from one
 * that declined the edit. A refused boolean is still `false` and still reaches that rule.
 */
export const githubPrMutationConfirmationSchema = z.boolean()
