import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// Mirrors the host GenerateCommitMessageResult (src/main/text-generation/
// commit-message-text-generation.ts) — a single resolved result, not a stream.
export type MobileGenerateCommitMessageResult =
  | { success: true; message: string }
  | { success: false; error: string; canceled?: boolean }

// Host-state changes. A lost reply here is unknown, never failed: none of these operations
// interprets a transport rejection, so the delivery-unknown marker reaches the caller intact.

/**
 * git.commit answers in-band: an accepted reply can still carry `success: false`.
 *
 * Nullish and every member optional because that is exactly what the consumer tolerates —
 * mobile-hosted-review-git-preparation.ts:107 compares `outcome.success === true` and :109 passes
 * `outcome.error` through hostReplyErrorTextOrFallback, which already reads a non-string as absent.
 * An absent or null payload stays a failed commit carrying the screen's copy, which is main's
 * documented contract for this reply ("reads as absent, not as a throw"), not an accident.
 * A present but non-boolean `success` is a malformed reply and now says so.
 */
const gitCommitOutcomeSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.unknown().optional()
  })

  .nullish()
  .transform((value) => ({ success: value?.success, error: value?.error }))

export const gitCommitRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.commit-staged',
    method: 'git.commit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('commit-outcome', gitCommitOutcomeSchema)
  })
)

// Three replies with no reader anywhere in mobile: the caller needs acceptance and nothing else.
// `z.unknown()` is the honest schema for that, not a holdout — there is no member to require, and
// requiring a shape mobile never looks at would reject hosts for no gain.
const unreadPayload = z.unknown()

/** Publish, push and force-with-lease are one operation; only the params differ. */
export const gitPushRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.push-branch',
    method: 'git.push',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-accepted', unreadPayload)
  })
)

export const gitBulkStageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.bulk-stage',
    method: 'git.bulkStage',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('stage-accepted', unreadPayload)
  })
)

const GENERATE_FAILED = 'Failed to generate commit message'

/**
 * Normalizes the host GenerateCommitMessageResult into the discriminated result the UI switches on.
 *
 * Always compatible by construction: every shape maps to a declared outcome, because a malformed
 * reply here must show the screen's copy rather than a decode error in a commit-message field.
 * The arms are main's four branches in main's order, including the one the recorded
 * `sc-commit-message-canceled` scenario takes — `{ success: false, error: '', canceled: true }`
 * keeps its cancel mark while its empty error falls back to the screen's copy.
 */
const NO_MESSAGE_GENERATED = 'No commit message generated'

const generatedCommitMessageSchema: z.ZodType<MobileGenerateCommitMessageResult, unknown> = z
  .union([
    z
      .object({ success: z.literal(true), message: z.string().min(1) })

      .transform((value): MobileGenerateCommitMessageResult => ({
        success: true,
        message: value.message
      })),
    z
      .object({
        success: z.literal(false),
        error: z.string().min(1),
        canceled: z.unknown().optional()
      })

      .transform((value): MobileGenerateCommitMessageResult => ({
        success: false,
        error: value.error,
        ...(value.canceled ? { canceled: true } : {})
      })),
    z
      .object({ success: z.literal(false), canceled: z.unknown().optional() })

      .transform((value): MobileGenerateCommitMessageResult => ({
        success: false,
        error: NO_MESSAGE_GENERATED,
        ...(value.canceled ? { canceled: true } : {})
      })),
    // Main split its fallback in two: a non-object reply says the generation failed, while an
    // object it could not read says none was generated. `typeof null === 'object'` is why the
    // guard is falsy rather than nullish.
    z
      .unknown()
      .refine((value) => !value || typeof value !== 'object')
      .transform((): MobileGenerateCommitMessageResult => ({
        success: false,
        error: GENERATE_FAILED
      }))
  ])
  .catch({ success: false, error: NO_MESSAGE_GENERATED })

export const gitGenerateCommitMessageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.generate-commit-message',
    method: 'git.generateCommitMessage',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('generated-commit-message', generatedCommitMessageSchema)
  })
)

/** Cancel is advisory: a refusal means the generation already finished, which is not an error. */
export const gitCancelGenerateCommitMessageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.cancel-generate-commit-message-or-skip',
    method: 'git.cancelGenerateCommitMessage',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('cancel-accepted', unreadPayload)
  })
)
