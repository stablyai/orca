import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  filePreviewImageSchema,
  filePreviewTextSchema,
  terminalArtifactWriteSchema,
  terminalPathResolutionSchema
} from './file-preview-reply-schema'

// Skip refusals so the screen can map host code/message to copy and refresh stale artifact grants; acceptance policies expose no refusal code.
// Malformed accepted replies throw into previewError. Split text/image readers by the same classifyMobileArtifact predicate used by request and response.

export const filePreviewTextRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.preview-text-or-skip',
    method: 'files.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-text', filePreviewTextSchema)
  })
)

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

export const terminalArtifactWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.write-terminal-artifact-or-skip',
    method: 'files.writeTerminalArtifact',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('artifact-written', terminalArtifactWriteSchema)
  })
)

// Refusal leaves the stale grant in place.
export const terminalArtifactPathResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.resolve-terminal-path-or-skip',
    method: 'files.resolveTerminalPath',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-path-resolution', terminalPathResolutionSchema)
  })
)

export type MobileFilePreviewRpcSender = Parameters<typeof filePreviewTextRead.request>[0]
