import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../mobile-file-preview-operations'
import { fileTapOpenedSchema } from './mobile-file-tap-reply-schema'
import '../../agent-history/mobile-ai-vault-resume-reply-schema'
import '../../browser/mobile-session-browser-reply-schema'
import '../../transport/rpc/rpc-uninterpreted-reply-schemas'

// Best-effort taps skip refused opens; explicit Changes-screen opens instead show the host error.
export const fileTapOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-tapped-file-or-skip',
    method: 'files.open',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('tapped-file-opened', fileTapOpenedSchema)
  })
)
