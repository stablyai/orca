import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { dictationSetupSchema, dictationUnreadReplySchema } from './dictation-reply-schema'

// The dictation setup sheet's reads and writes, and the three sends one dictation session makes.
// Every refusing site here surfaces the host's own message with a screen fallback, so they share
// one policy and differ only in the copy they fall back to, which stays at the call site.
//
// Three of the eight read a setup the sheet renders, and those are checked. The other five read no
// reply body at all, or read it past a guard whose order is load-bearing; dictation-reply-schema.ts
// says which and why. An unreadable setup now reaches the sheet's own catch through
// `interpretOrThrowRefusalMessage`, which shows the host-reply message where main showed
// `undefined` models and then crashed the refresh on `.some`.

export const dictationSetupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-setup',
    method: 'speech.models.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-setup', dictationSetupSchema)
  })
)

/** Starts a download; the sheet polls `speech.models.list` for progress rather than reading this. */
export const dictationModelDownload = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-model-download',
    method: 'speech.models.download',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-download-started', dictationUnreadReplySchema)
  })
)

/** Both writes answer with the whole setup again, which the sheet renders in place of a refetch. */
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

/**
 * The transcript sits on the reply, but the member read stays at the call site: main checked the
 * refusal before its staleness guard and read `.text` after it, so folding the read into the
 * operation would move the property-read exception across that guard.
 */
export const dictationSessionFinish = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-finish',
    method: 'speech.dictation.finish',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-finished', dictationUnreadReplySchema)
  })
)

/**
 * Cancel is the only dictation send no call site interprets: all five are cleanup, running under
 * `catch(() => undefined)` or inside `Promise.allSettled`, and the session is already gone locally
 * whatever the host answers. The policy is declared anyway so the operation has one — a refused
 * cancel leaves host state alone, which is what a skip means — but no golden can observe it.
 */
export const dictationSessionCancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.dictation-cancel-or-skip',
    method: 'speech.dictation.cancel',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dictation-cancelled', dictationUnreadReplySchema)
  })
)
