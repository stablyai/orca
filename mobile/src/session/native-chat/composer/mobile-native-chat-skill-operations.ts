import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../terminal/terminal-reply-schema'
import { skillDiscoveryReplySchema } from './mobile-native-chat-skill-reply-schema'

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
