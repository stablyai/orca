import type { HarnessConversationDriverSink } from './driver'
import type { AgentPermissionMode } from '../../shared/tui-agent-permissions'

export type ClaudeDriverOptions = {
  agent: 'claude' | 'openclaude'
  cwd: string
  providerSessionId: string | null
  newProviderSessionId?: string
  forkFromProviderSessionId: string | null
  command: string
  commandArgs: string[]
  permissionMode: AgentPermissionMode
  env: NodeJS.ProcessEnv
  sink: HarnessConversationDriverSink
}
