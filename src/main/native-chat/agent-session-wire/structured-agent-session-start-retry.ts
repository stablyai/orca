import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { claudeStartupAnswer } from '../../claude/claude-startup-failure'
import { temporaryCodexStartupAnswer } from '../../codex/app-server/codex-startup-failure'
import { CodexAppServerUnsupportedError } from '../../codex/app-server/codex-app-server-session'
import { temporaryAcpStartupAnswer } from '../../acp/acp-startup-failure'
import { AcpRpcError } from '../../acp/acp-errors'
import { JsonlRpcResponseError } from '../../jsonl-rpc/peer'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import {
  providerExecutableMissing,
  providerLaunchFolderMissing
} from '../../provider-process/provider-executable-missing'
import { providerRequestTimeoutOf } from '../../provider-process/provider-request-timeout'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import { agentCliInstallationProblemOf } from '../agent-cli-installation-error'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import { providerExitObserved } from './structured-agent-session-failure-text'

function agentStartAnswer(error: Error): 'temporary' | 'final' | undefined {
  if (error instanceof CodexAppServerRequestError) {
    return temporaryCodexStartupAnswer(error) ? 'temporary' : 'final'
  }
  if (error instanceof CodexAppServerUnsupportedError || error instanceof JsonlRpcResponseError) {
    return 'final'
  }
  if (error instanceof AcpRpcError) {
    return temporaryAcpStartupAnswer(error) ? 'temporary' : 'final'
  }
  return claudeStartupAnswer(error)
}

/** Only positive provider evidence retries; an Orca fault or a typed refusal stays final. */
export function retryableStructuredAgentSessionStart(
  error: unknown,
  unexpectedExit = false
): boolean {
  if (
    providerRequestTimeoutOf(error) ||
    argumentProblemOf(error) ||
    agentCliInstallationProblemOf(error) ||
    providerExecutableMissing(error) ||
    providerLaunchFolderMissing(error)
  ) {
    return false
  }
  const final = findInErrorChain(error, (cause) =>
    cause instanceof AggregateError ||
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    cause instanceof AgentSessionAcquisitionRefusal ||
    isAgentSessionPreSpawnError(cause) ||
    agentStartAnswer(cause) === 'final'
      ? true
      : undefined
  )
  if (final) {
    return false
  }
  return (
    unexpectedExit ||
    providerExitObserved(error) ||
    findInErrorChain(error, (cause) =>
      agentStartAnswer(cause) === 'temporary' ||
      ('code' in cause && ['EAGAIN', 'EMFILE', 'ENFILE'].some((code) => code === cause.code))
        ? true
        : undefined
    ) === true
  )
}

export function retryableStructuredAgentSessionAcquisition(error: unknown): boolean {
  return (
    (error instanceof AgentSessionAcquisitionExitProvenError ||
      error instanceof AgentSessionAcquisitionRootExitObservedError) &&
    retryableStructuredAgentSessionStart(error)
  )
}
