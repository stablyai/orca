import type { AgentCliInstallationProblem } from '../../shared/agent-cli-installation-problem'
import {
  agentCliTooOldWords,
  sayAgentSessionFailureEnglish
} from '../../shared/agent-session-failure-copy'
import type { TuiAgent } from '../../shared/tui-agent'
import { AgentSessionPreSpawnError } from './agent-session-wire/structured-agent-session-adapter'
import { findInErrorChain } from '../provider-process/provider-error-chain'

/** A chat launch refused before spawning: the agent's binary is older than its chats need. */
export class AgentCliInstallationError extends AgentSessionPreSpawnError {
  readonly installation: AgentCliInstallationProblem

  constructor(installation: AgentCliInstallationProblem) {
    super(agentCliTooOldWords(installation, sayAgentSessionFailureEnglish))
    this.installation = installation
  }

  static tooOld(
    agent: TuiAgent,
    check: { version: string; minimumVersion: string }
  ): AgentCliInstallationError {
    return new AgentCliInstallationError({
      agent,
      installedVersion: check.version,
      minimumVersion: check.minimumVersion
    })
  }
}

export function agentCliInstallationProblemOf(
  error: unknown
): AgentCliInstallationProblem | undefined {
  return findInErrorChain(error, (inner) =>
    inner instanceof AgentCliInstallationError ? inner.installation : undefined
  )
}
