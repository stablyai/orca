import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant, rpcResultVariants } from '../transport/rpc-operation-result-reader'
import {
  fileTabBinaryDiffSchema,
  fileTabImageSchema,
  fileTabTextDiffSchema,
  fileTabTextSchema,
  type MobileFileTabDiff
} from './file-tab-doc-reply-schema'

// Throw refusals into the tab’s error document; the preview screen instead renders refusals as body copy.
// Tabs publish ready fields unguarded, so their readers are stricter than preview normalizers; malformed replies reach readFileTab’s existing catch.

// Unknown diff kind strings follow the existing non-text branch; text arms require their own members.
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

export type MobileFileTabDocRpcSender = Parameters<typeof fileTabTextRead.request>[0]
