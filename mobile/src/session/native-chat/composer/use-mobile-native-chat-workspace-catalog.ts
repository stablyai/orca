import type { RpcClient } from '../../../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from '../../mobile-structured-agent-session-host-support'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatSkills } from './use-mobile-native-chat-skills'

/** The workspace's files for `@` and its disk-scanned skills for `/` and `$`. */
export function useMobileNativeChatWorkspaceCatalog(
  scope: {
    client: RpcClient | null
    worktreeId: string
    agentSessionHostSupport?: StructuredAgentSessionHostSupport | null
  },
  agent: string | null
): ReturnType<typeof useMobileNativeChatFileSearch> & ReturnType<typeof useMobileNativeChatSkills> {
  const { client, worktreeId } = scope
  const files = useMobileNativeChatFileSearch({ client, worktreeId })
  const skills = useMobileNativeChatSkills({
    client,
    worktreeId,
    agent,
    supported: scope.agentSessionHostSupport?.discoverWorkspaceSkills === true
  })
  return { ...files, ...skills }
}
