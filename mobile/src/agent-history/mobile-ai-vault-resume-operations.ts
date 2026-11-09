import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import '../files/mobile-file-preview-operations'
import { aiVaultResumePreparationSchema } from './mobile-ai-vault-resume-reply-schema'
import '../browser/mobile-session-browser-reply-schema'
import '../files/session-documents/mobile-file-tap-reply-schema'
import '../transport/rpc/rpc-uninterpreted-reply-schemas'

// Legacy resume reads unsupported-method refusals raw to fall back to shared home.
export const aiVaultResumePreparationRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'aiVault.prepare-session-resume',
    method: 'aiVault.prepareSessionResume',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ai-vault-resume-preparation', aiVaultResumePreparationSchema)
  })
)
