import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../../files/preview/mobile-file-preview-operations'
import { browserTabCreatedSchema } from './mobile-session-browser-reply-schema'
import '../../agent-history/mobile-ai-vault-resume-reply-schema'
import '../../files/session-documents/mobile-file-tap-reply-schema'

export const sessionBrowserTabCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'browser.create-session-tab',
    method: 'browser.tabCreate',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('browser-tab-created', browserTabCreatedSchema)
  })
)
