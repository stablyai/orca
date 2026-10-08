import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  filePreviewImageSchema,
  filePreviewTextSchema,
  terminalArtifactWriteSchema,
  terminalPathResolutionSchema
} from './file-preview-reply-schema'

/**
 * The preview screen's reads and writes.
 *
 * Every one of them is a skip rather than a throw, because a refused preview is not an error the
 * screen raises: it is a result the screen renders. The refusal itself stays at the call site,
 * which maps the host's code and message into display copy (`previewError`) and decides whether
 * the failure is a stale terminal-artifact grant worth refreshing. No acceptance policy exposes a
 * refusal code, and only these two consumers want one.
 *
 * What a *malformed* accepted reply does is what changes here. A skip's reader is consulted only
 * after the policy has already admitted the reply, so an unreadable payload throws
 * `RpcIncompatibleReplyError` naming the method; the preview screen's own try/catch runs it back
 * through `previewError`, which lands on 'Unable to load preview' — the copy main already showed
 * for an unreadable text payload, and a truer one than the 'Binary preview unavailable' main gave
 * an unreadable image payload.
 *
 * The text and image readers are split by method rather than by path: `createMobileFilePreviewRequest`
 * picks the method from `classifyMobileArtifact`, and `loadMobileFilePreview` normalizes with the
 * same predicate over the same path, so each method has exactly one projection behind it.
 */

/** files.read for a preview. The tab doc asks the same method under a throwing policy. */
export const filePreviewTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.preview-text-or-skip',
    method: 'files.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-text', filePreviewTextSchema)
  })
)

/** files.readPreview for a preview; the tab doc's image read is the other policy on it. */
export const filePreviewImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.preview-image-or-skip',
    method: 'files.readPreview',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-image', filePreviewImageSchema)
  })
)

export const terminalArtifactTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.terminal-artifact-text-or-skip',
    method: 'files.readTerminalArtifact',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-text', filePreviewTextSchema)
  })
)

export const terminalArtifactImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.terminal-artifact-image-or-skip',
    method: 'files.readTerminalArtifactPreview',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-image', filePreviewImageSchema)
  })
)

/** The save. Its reply body is never read: a success is the whole answer. */
export const terminalArtifactWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.write-terminal-artifact-or-skip',
    method: 'files.writeTerminalArtifact',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('artifact-written', terminalArtifactWriteSchema)
  })
)

/** Re-resolves a terminal path to mint a fresh grant. A refusal leaves the stale grant in place. */
export const terminalArtifactPathResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.resolve-terminal-path-or-skip',
    method: 'files.resolveTerminalPath',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-path-resolution', terminalPathResolutionSchema)
  })
)

/** What a preview send takes, named from an operation so no module names the raw port. */
export type MobileFilePreviewRpcSender = Parameters<typeof filePreviewTextRead.request>[0]
