import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { aiVaultResumePreparationSchema } from './mobile-ai-vault-resume-reply-schema'

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
