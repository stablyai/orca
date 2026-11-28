/** The launch an adapter composes: the `zcode` program, the handle it resumes, and the chat's env. */

import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleLink
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentLaunchPartResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import { resolveZcodeCommand } from './zcode-command'

export type ZcodeResolvedLaunch = {
  command: string
  prefixArgs: readonly string[]
  /** The conversation a `--resume` continues; null for a chat that has none yet. */
  previous: AgentSessionProviderHandleLink | null
}

export function zcodeLaunchPart(): StructuredAgentLaunchPartResolver<ZcodeResolvedLaunch> {
  return async (basis, _identity: AgentSessionJournalIdentity) => {
    const env = await basis.environment()
    const command = resolveZcodeCommand(env, basis.commandSettings())
    return {
      launch: {
        command: command.command,
        prefixArgs: command.prefixArgs ?? [],
        previous: agentSessionProviderHandleChainHead(basis.record.providerHandleChain)
      },
      env,
      inheritedEnvToDelete: []
    }
  }
}
