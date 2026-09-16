import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * What a session file tab reads to render one document.
 *
 * All three throw the host's message on refusal, which is the opposite of the preview screen's
 * policy on the same two file methods: a tab maps the throw to an error doc and keeps the tab,
 * while the preview screen renders the refusal as body copy. Two policies, two families, named
 * here and in mobile-file-preview-operations.ts so neither can drift onto the other.
 *
 * The payloads stay unchecked: the tab picks its projection from the path, and moving a shape
 * check into a reader would reject replies the tab renders today.
 */

export const fileTabDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.file-tab-diff',
    method: 'git.diff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-tab-diff')
  })
)

export const fileTabTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.file-tab-text',
    method: 'files.read',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-tab-text')
  })
)

export const fileTabImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.file-tab-image',
    method: 'files.readPreview',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('file-tab-image')
  })
)

/** What a file tab reads with, named from an operation so no module names the raw port. */
export type MobileFileTabDocRpcSender = Parameters<typeof fileTabTextRead.request>[0]
