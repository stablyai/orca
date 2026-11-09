import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../terminal/terminal-reply-schema'
import { skillDiscoveryReplySchema } from './mobile-native-chat-skill-reply-schema'
import '../../agent-launch/mobile-agent-detection-reply-schema'
import '../../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../../terminal/session/mobile-session-terminal-reply-schema'
import '../../../worktree/session-worktree-record-reply-schema'
import '../../../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../../../files/workspace-file-paths-reply-schema'

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
