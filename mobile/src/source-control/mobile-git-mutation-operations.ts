import { z } from 'zod'
import type { TextGenerationFailureFields } from '../../../src/shared/text-generation-failure-copy'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export type MobileGenerateCommitMessageResult =
  | { success: true; message: string }
  | ({ success: false; canceled?: boolean } & TextGenerationFailureFields)

// Preserve delivery-unknown on lost mutation replies; rejection does not prove the host did nothing.

// Accepted commits may fail in-band; absent/null payloads remain failed outcomes, while malformed success flags reject.
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

// Only acceptance is consumed; requiring unread payload fields would reject compatible hosts.
const unreadPayload = z.unknown()

export const gitPushRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.push-branch',
    method: 'git.push',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-accepted', unreadPayload)
  })
)

export const gitFastForwardRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.fast-forward-branch',
    method: 'git.fastForward',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('fast-forward-accepted', unreadPayload)
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

// Normalize malformed generation replies to UI fallbacks; preserve cancellation even with an empty error.
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
        error: z.string().min(1).catch(NO_MESSAGE_GENERATED),
        errorCode: z.string().optional().catch(undefined),
        errorParams: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .catch(undefined),
        errorDetail: z.string().optional().catch(undefined),
        canceled: z.unknown().optional()
      })

      .transform((value): MobileGenerateCommitMessageResult => ({
        success: false,
        error: value.error,
        ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
        ...(value.errorParams !== undefined ? { errorParams: value.errorParams } : {}),
        ...(value.errorDetail !== undefined ? { errorDetail: value.errorDetail } : {}),
        ...(value.canceled ? { canceled: true } : {})
      })),
    // Null/non-object means generation failed; unreadable objects use the no-message fallback.
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

export const gitCancelGenerateCommitMessageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.cancel-generate-commit-message-or-skip',
    method: 'git.cancelGenerateCommitMessage',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('cancel-accepted', unreadPayload)
  })
)
