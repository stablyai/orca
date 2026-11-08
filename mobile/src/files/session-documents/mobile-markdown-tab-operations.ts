import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../mobile-file-preview-operations'
import { sessionLaunchUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../agent-history/mobile-ai-vault-resume-reply-schema'
import '../../browser/mobile-session-browser-reply-schema'
import './mobile-file-tap-reply-schema'

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

import '../../terminal/terminal-reply-schema'
import { markdownTabDocumentSchema } from './mobile-markdown-tab-reply-schema'
import '../../session/agent-launch/mobile-agent-detection-reply-schema'

import '../../terminal/session/mobile-session-terminal-reply-schema'
import '../../worktree/session-worktree-record-reply-schema'
import '../../session/native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../workspace-file-paths-reply-schema'

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

import '../../session/tabs/mobile-session-tab-write-reply-schema'

import '../../terminal/quick-commands/mobile-quick-command-operations'

export const markdownTabSave = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'markdown.save-tab',
    method: 'markdown.saveTab',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-tab-doc', markdownTabDocumentSchema)
  })
)
