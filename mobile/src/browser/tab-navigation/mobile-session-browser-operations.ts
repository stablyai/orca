import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import {
  browserProfileListSchema,
  browserTabCreatedSchema
} from './mobile-session-browser-reply-schema'

export const sessionBrowserTabCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'browser.create-session-tab',
    method: 'browser.tabCreate',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('browser-tab-created', browserTabCreatedSchema)
  })
)

// Older hosts refuse it at the phone allow-list; that reads as no profiles to show.
export const browserProfileListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'browser.profile-list',
    method: 'browser.profileList',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('browser-profiles', browserProfileListSchema)
  })
)
