import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  detectedAgentsSchema,
  markdownTabDocumentSchema,
  refreshedAgentsSchema,
  runtimeRepoListSchema,
  sessionForwardedReplySchema,
  sessionTerminalInventorySchema,
  sessionWorktreeRecordSchema,
  skillDiscoveryReplySchema,
  terminalQuickCommandsSchema,
  workspaceFilePathsSchema
} from './session-read-reply-schema'

// Skip refused inventories as no news; an empty list would erase the existing strip.
export const sessionTerminalListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.list',
    method: 'terminal.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-inventory', sessionTerminalInventorySchema)
  })
)

export type MobileRuntimeRepoSummary = {
  id: string
  connectionId?: string | null
  executionHostId?: string | null
}

const repoListReader = rpcResultVariant('runtime-repo-list', runtimeRepoListSchema)

// Keep separate refusal policies: connection/agent loaders surface errors, while advisory probes and refreshes retain their previous state.
export const newTabRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-for-new-tab',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)

export const nativeChatRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-or-unreadable',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)

// Launch detection surfaces host refusals; advisory task-drawer readers intentionally skip them.
export const preflightDetectAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-agents',
    method: 'preflight.detectAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)

export const preflightRefreshAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.refresh-agents',
    method: 'preflight.refreshAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('refreshed-agents', refreshedAgentsSchema)
  })
)

export const preflightDetectRemoteAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)

// Leave replies raw until the controller’s generation, barrier and application-revision guards pass.
export const sessionTabsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-list',
    method: 'session.tabs.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tabs-snapshot', sessionForwardedReplySchema)
  })
)

// Skip refusals to retain suggestions; inspect method_not_found first to fall back from search to inventory.
export const nativeChatFileSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.search-paths-or-skip',
    method: 'files.searchPaths',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)

export const nativeChatFileInventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)

// Retain the live window on refusal and let the caller offer retry; read the whole legacy error/window union before selecting messages.
export const nativeChatSessionPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'nativeChat.read-session-page-or-skip',
    method: 'nativeChat.readSession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-session-page', sessionForwardedReplySchema)
  })
)

export const quickCommandsReader = rpcResultVariant(
  'terminal-quick-commands',
  terminalQuickCommandsSchema
)

// Load/save share the canonical parser; malformed lists remain null so they cannot erase host commands as an empty list.
export const quickCommandsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-read',
    method: 'settings.getTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)

// Read the whole worktree for notes and live title; unlike mutation readers, absent records need no error or wrong-host fallback.
export const sessionWorktreeRecordRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.show-record-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-record', sessionWorktreeRecordSchema)
  })
)

// Inspect renderer_unavailable before interpretation so headless hosts can fall back to disk.
export const markdownTabRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'markdown.read-tab',
    method: 'markdown.readTab',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-tab-doc', markdownTabDocumentSchema)
  })
)

// Mobile names the workspace and lets the host resolve and scan it; see SKILL_DISCOVER_WORKSPACE_CAPABILITY.
export const nativeChatSkillDiscoveryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'skills.discover-or-skip',
    method: 'skills.discover',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('skill-discovery', skillDiscoveryReplySchema)
  })
)
