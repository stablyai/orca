import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * The preview screen's reads and writes.
 *
 * Every one of them is a skip rather than a throw, because a refused preview is not an error the
 * screen raises: it is a result the screen renders. The refusal itself stays at the call site,
 * which maps the host's code and message into display copy (`previewError`) and decides whether
 * the failure is a stale terminal-artifact grant worth refreshing. No acceptance policy exposes a
 * refusal code, and only these two consumers want one.
 *
 * The payloads are unchecked here because the shape depends on the path, not on the method:
 * `normalizeMobileFilePreviewResult` picks the image or text projection from the file name, which
 * a module-level reader cannot see.
 */

/** files.read for a preview. The tab doc asks the same method under a throwing policy. */
export const filePreviewTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.preview-text-or-skip',
    method: 'files.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-preview')
  })
)

/** files.readPreview for a preview; the tab doc's image read is the other policy on it. */
export const filePreviewImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.preview-image-or-skip',
    method: 'files.readPreview',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-preview')
  })
)

export const terminalArtifactTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.terminal-artifact-text-or-skip',
    method: 'files.readTerminalArtifact',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-preview')
  })
)

export const terminalArtifactImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.terminal-artifact-image-or-skip',
    method: 'files.readTerminalArtifactPreview',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-preview')
  })
)

/** The save. Its reply body is never read: a success is the whole answer. */
export const terminalArtifactWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.write-terminal-artifact-or-skip',
    method: 'files.writeTerminalArtifact',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('artifact-written')
  })
)

/** Re-resolves a terminal path to mint a fresh grant. A refusal leaves the stale grant in place. */
export const terminalArtifactPathResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.resolve-terminal-path-or-skip',
    method: 'files.resolveTerminalPath',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('terminal-path-resolution')
  })
)

/** What a preview send takes, named from an operation so no module names the raw port. */
export type MobileFilePreviewRpcSender = Parameters<typeof filePreviewTextRead.request>[0]
