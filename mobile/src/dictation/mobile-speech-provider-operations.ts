import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  speechProviderKeyTestSchema,
  speechProvidersStateSchema
} from './speech-provider-reply-schema'

// The provider cabinet's sends. Every write answers with the whole state, which the screens render
// in place of a refetch; the list read doubles as the capability probe (see mobile-speech-providers.ts).

export const speechProvidersRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.providers-list',
    method: 'speech.providers.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('speech-providers', speechProvidersStateSchema)
  })
)

export const speechProviderKeySave = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.providers-save-key',
    method: 'speech.providers.saveKey',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('speech-providers', speechProvidersStateSchema)
  })
)

export const speechProviderKeyClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.providers-clear-key',
    method: 'speech.providers.clearKey',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('speech-providers', speechProvidersStateSchema)
  })
)

export const speechProviderKeyTest = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.providers-test-key',
    method: 'speech.providers.testKey',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('speech-provider-key-test', speechProviderKeyTestSchema)
  })
)

export const speechProvidersConfigure = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'speech.providers-configure',
    method: 'speech.providers.configure',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('speech-providers', speechProvidersStateSchema)
  })
)
