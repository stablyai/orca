import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant, rpcResultVariants } from '../transport/rpc-operation-result-reader'
import {
  fileTabBinaryDiffSchema,
  fileTabImageSchema,
  fileTabTextDiffSchema,
  fileTabTextSchema,
  type MobileFileTabDiff
} from './file-tab-doc-reply-schema'

/**
 * What a session file tab reads to render one document.
 *
 * All three throw the host's message on refusal, which is the opposite of the preview screen's
 * policy on the same two file methods: a tab maps the throw to an error doc and keeps the tab,
 * while the preview screen renders the refusal as body copy. Two policies, two families, named
 * here and in mobile-file-preview-operations.ts so neither can drift onto the other.
 *
 * The readers are stricter than the preview screen's for the same reason the policies differ: a tab
 * publishes what it read into a typed ready document with no guard, so a member the preview screen
 * normalizes is one the tab renders as `undefined`. An unreadable reply now reaches `readFileTab`'s
 * catch as one named error instead of a property-read TypeError, and that catch already shows
 * "Couldn't load file preview" for both.
 */

/**
 * The diff a staged or unstaged tab renders.
 *
 * Two variants, because the host's own result is a union whose arms require different members and
 * whose arm set is a wire surface: a `kind` this build has not heard of takes the binary arm, which
 * is the branch main's `kind !== 'text'` already sent it down.
 */
export const fileTabDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.file-tab-diff',
    method: 'git.diff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariants<'file-tab-text-diff' | 'file-tab-binary-diff', MobileFileTabDiff>([
      rpcResultVariant('file-tab-text-diff', fileTabTextDiffSchema),
      rpcResultVariant('file-tab-binary-diff', fileTabBinaryDiffSchema)
    ])
  })
)

export const fileTabTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.file-tab-text',
    method: 'files.read',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-tab-text', fileTabTextSchema)
  })
)

export const fileTabImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.file-tab-image',
    method: 'files.readPreview',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-tab-image', fileTabImageSchema)
  })
)

/** What a file tab reads with, named from an operation so no module names the raw port. */
export type MobileFileTabDocRpcSender = Parameters<typeof fileTabTextRead.request>[0]
