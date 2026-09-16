import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// Opening things from the session screen: a tapped terminal path, a new markdown note or browser
// tab, the legacy-Codex resume repin, and the structured agent chat.

// The tap resolves the same path on the same method, with the same skip on refusal and the same
// whole-payload read, as the preview screen's grant refresh, so a second operation would only be a
// second name for one wire. Same reason `fileOwnershipRuntimeStatusRead` re-exports the Tasks
// screen's status read.
export { terminalArtifactPathResolve as fileTapPathResolve } from '../files/mobile-file-preview-operations'

/**
 * The worktree open a tap leads to. Its own skip: the tap is best-effort and a refusal is the same
 * silent miss as a path that resolved to nothing. `sourceFileOpenRun` is the Changes screen's read
 * of the same method and raises the host's message instead, because there the user asked for a tab
 * and has nothing otherwise.
 */
export const fileTapOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-tapped-file-or-skip',
    method: 'files.open',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('tapped-file-opened')
  })
)

/**
 * Creating an untitled markdown note. The refusal message is read for the file-exists text the
 * caller retries on, so it has to survive as the thrown message rather than a coded one.
 */
export const sessionMarkdownNoteCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.create-markdown-note',
    method: 'files.createFile',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('markdown-note-created')
  })
)

/** The browser tab a user opens from the tab strip; the reply carries the page id to focus. */
export const sessionBrowserTabCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'browser.create-session-tab',
    method: 'browser.tabCreate',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('browser-tab-created')
  })
)

/**
 * The legacy-Codex resume repin. Its refusal is read raw before interpretation: an older host that
 * cannot prepare answers `method_not_found` or a named `forbidden`, and the phone resumes on the
 * shared home instead — neither a failure nor a value any acceptance policy can express.
 */
export const aiVaultResumePreparationRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'aiVault.prepare-session-resume',
    method: 'aiVault.prepareSessionResume',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('ai-vault-resume-preparation')
  })
)

/**
 * Whether a workspace can host a structured agent chat at all. The launch distrusts the declared
 * envelope type here — a malformed reply must read as unsupported rather than be classified — so
 * the raw reply stays at the call site and no policy interprets it.
 */
export const structuredAgentSupportProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.create-support',
    method: 'agentSession.createSupport',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('structured-create-support')
  })
)

/**
 * The durable create. Same distrust, and for a stronger reason: anything this call cannot prove is
 * a definitive refusal has to stay `unknown`, because a create that may have committed must not
 * grow a sibling terminal. The envelope is examined field by field at the call site.
 */
export const structuredAgentSessionCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.create',
    method: 'agentSession.create',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('structured-session-created')
  })
)

/** The host record a session-option pick is written to. Best-effort: every outcome is swallowed. */
export const nativeChatSessionOptionsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.mutate-native-chat-session-options',
    method: 'settings.mutateNativeChatSessionOptions',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('native-chat-session-options-written')
  })
)
