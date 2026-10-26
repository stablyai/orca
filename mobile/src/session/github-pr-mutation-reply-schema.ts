import { z } from 'zod'

// No ok member means the host’s legacy unstructured success.
export type GitHubPrMutationStatus =
  | { readonly structured: false }
  | { readonly structured: true; readonly ok: unknown; readonly error: unknown }

// Require presence of ok, not its type: callers compare it to true and safely inspect string/object errors.
const mutationStatusEnvelopeSchema = z
  .looseObject({ ok: z.unknown(), error: z.unknown().optional() })
  .transform((reply): GitHubPrMutationStatus => ({
    structured: true,
    ok: reply.ok,
    error: reply.error
  }))

// Keep the envelope arm first; other payloads, including void, retain legacy unstructured-success semantics.
const mutationVoidSchema = z
  .unknown()
  .transform((): GitHubPrMutationStatus => ({ structured: false }))

export const githubPrMutationStatusSchemas = [
  mutationStatusEnvelopeSchema,
  mutationVoidSchema
] as const

// Require a boolean so protocol drift cannot look like an ordinary declined mutation.
export const githubPrMutationConfirmationSchema = z.boolean()
