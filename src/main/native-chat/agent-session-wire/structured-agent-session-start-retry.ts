import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { ClaudeControlRequestError } from '../../claude/claude-agent-sdk-control-requests'
import { AcpRpcError } from '../../acp/acp-errors'
import { JsonlRpcResponseError } from '../../jsonl-rpc/peer'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { providerExecutableMissing } from '../../provider-process/provider-executable-missing'
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

/** Only positive provider evidence retries; an Orca fault or a typed refusal stays final. */
export function retryableStructuredAgentSessionStart(error: unknown): boolean {
  if (
    providerRequestTimeoutOf(error) ||
    argumentProblemOf(error) ||
    agentCliInstallationProblemOf(error) ||
    providerExecutableMissing(error)
  ) {
    return false
  }
  const final = findInErrorChain(error, (cause) =>
    cause instanceof AggregateError ||
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    cause instanceof AgentSessionAcquisitionRefusal ||
    isAgentSessionPreSpawnError(cause)
      ? true
      : undefined
  )
  if (final) {
    return false
  }
  return (
    providerExitObserved(error) ||
    findInErrorChain(error, (cause) =>
      cause instanceof CodexAppServerRequestError ||
      cause instanceof ClaudeControlRequestError ||
      cause instanceof AcpRpcError ||
      cause instanceof JsonlRpcResponseError ||
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
