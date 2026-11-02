import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { dictationSetupSchema, dictationUnreadReplySchema } from './dictation-reply-schema'

// Share refusal-message policy across dictation sends; fallback copy stays at each call site.
// Setup replies are checked; bodyless replies and the transcript read behind a staleness guard follow dictation-reply-schema.ts.

export const dictationSetupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-setup',
    method: 'speech.models.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-setup', dictationSetupSchema)
  })
)

// The sheet polls models.list for progress; it never reads the download reply body.
export const dictationModelDownload = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-model-download',
    method: 'speech.models.download',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-download-started', dictationUnreadReplySchema)
  })
)

// Both writes replace the displayed setup without a refetch.
export const dictationModelDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-model-delete',
    method: 'speech.models.delete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-setup', dictationSetupSchema)
  })
)

export const dictationConfigWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-config',
    method: 'speech.dictation.setup',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-setup', dictationSetupSchema)
  })
)

export const dictationSessionStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-start',
    method: 'speech.dictation.start',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-started', dictationUnreadReplySchema)
  })
)

export const dictationAudioChunkSend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-chunk',
    method: 'speech.dictation.chunk',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-chunk-received', dictationUnreadReplySchema)
  })
)

// Keep transcript reads after the caller’s staleness guard; moving them here would expose property-read failures from superseded dictation.
export const dictationSessionFinish = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-finish',
    method: 'speech.dictation.finish',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-finished', dictationUnreadReplySchema)
  })
)

// Cancel callers already discarded local state and ignore cleanup failures; declare skip policy even though no caller interprets it.
export const dictationSessionCancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-cancel-or-skip',
    method: 'speech.dictation.cancel',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-cancelled', dictationUnreadReplySchema)
  })
)
