import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked, rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// Mirrors the host GenerateCommitMessageResult (src/main/text-generation/
// commit-message-text-generation.ts) — a single resolved result, not a stream.
export type MobileGenerateCommitMessageResult =
  | { success: true; message: string }
  | { success: false; error: string; canceled?: boolean }

// Host-state changes. A lost reply here is unknown, never failed: none of these operations
// interprets a transport rejection, so the delivery-unknown marker reaches the caller intact.

/** Exactly `result?.key`, so a null or absent commit payload reads as absent, not as a throw. */
function optionalPayloadMember(raw: unknown, key: string): unknown {
  return raw == null ? undefined : Object(raw)[key]
}

const gitCommitOutcomeReader: RpcCompatibleReader<
  unknown,
  'commit-outcome',
  { success: unknown; error: unknown }
> = (raw) =>
  rpcReadUnchecked('commit-outcome', {
    success: optionalPayloadMember(raw, 'success'),
    error: optionalPayloadMember(raw, 'error')
  })

/** git.commit answers in-band: an accepted reply can still carry `success: false`. */
export const gitCommitRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.commit-staged',
    method: 'git.commit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: gitCommitOutcomeReader
  })
)

/** Publish, push and force-with-lease are one operation; only the params differ. */
export const gitPushRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.push-branch',
    method: 'git.push',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('push-accepted')
  })
)

export const gitBulkStageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.bulk-stage',
    method: 'git.bulkStage',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('stage-accepted')
  })
)

const GENERATE_FAILED = 'Failed to generate commit message'

// Normalizes the host GenerateCommitMessageResult into the discriminated result the UI switches
// on. A malformed `{ success:false }` could leave `error` undefined, which breaks that contract,
// so the message is always coerced to a non-empty string.
const generatedCommitMessageReader: RpcCompatibleReader<
  unknown,
  'generated-commit-message',
  MobileGenerateCommitMessageResult
> = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return rpcReadUnchecked('generated-commit-message', { success: false, error: GENERATE_FAILED })
  }

  const result: { success?: unknown; message?: unknown; error?: unknown; canceled?: unknown } = raw

  if (result.success === true && typeof result.message === 'string' && result.message.length > 0) {
    return rpcReadUnchecked('generated-commit-message', { success: true, message: result.message })
  }

  const hostError =
    result.success === false && typeof result.error === 'string' && result.error.length > 0
      ? result.error
      : 'No commit message generated'

  return rpcReadUnchecked('generated-commit-message', {
    success: false,
    error: hostError,
    ...(result.success === false && result.canceled ? { canceled: true } : {})
  })
}

export const gitGenerateCommitMessageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.generate-commit-message',
    method: 'git.generateCommitMessage',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: generatedCommitMessageReader
  })
)

/** Cancel is advisory: a refusal means the generation already finished, which is not an error. */
export const gitCancelGenerateCommitMessageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.cancel-generate-commit-message-or-skip',
    method: 'git.cancelGenerateCommitMessage',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('cancel-accepted')
  })
)
