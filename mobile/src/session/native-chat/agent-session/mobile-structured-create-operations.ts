import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../files/mobile-file-preview-operations'
import { sessionLaunchUnreadReplySchema } from '../../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../../agent-history/mobile-ai-vault-resume-reply-schema'
import '../../../browser/tab-navigation/mobile-session-browser-reply-schema'
import '../../../files/session-documents/mobile-file-tap-reply-schema'

// Treat malformed support replies as unsupported; inspect raw fields at the caller.
export const structuredAgentSupportProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.create-support',
    method: 'agentSession.createSupport',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('structured-create-support', sessionLaunchUnreadReplySchema)
  })
)

// Only definitive create refusals permit fallback; malformed/uncertain replies may already have created a session.
export const structuredAgentSessionCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.create',
    method: 'agentSession.create',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('structured-session-created', sessionLaunchUnreadReplySchema)
  })
)
