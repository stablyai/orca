import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  aiVaultResumePreparationSchema,
  browserTabCreatedSchema,
  fileTapOpenedSchema,
  sessionLaunchUnreadReplySchema
} from './session-launch-reply-schema'

// Reuse the preview resolver’s identical wire policy and whole-payload reader.
export { terminalArtifactPathResolve as fileTapPathResolve } from '../files/mobile-file-preview-operations'

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

// Keep the host’s file-exists message so note creation can retry.
export const sessionMarkdownNoteCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.create-markdown-note',
    method: 'files.createFile',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-note-created', sessionLaunchUnreadReplySchema)
  })
)

export const sessionBrowserTabCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'browser.create-session-tab',
    method: 'browser.tabCreate',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('browser-tab-created', browserTabCreatedSchema)
  })
)

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

export const nativeChatSessionOptionsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.mutate-native-chat-session-options',
    method: 'settings.mutateNativeChatSessionOptions',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-session-options-written', sessionLaunchUnreadReplySchema)
  })
)
