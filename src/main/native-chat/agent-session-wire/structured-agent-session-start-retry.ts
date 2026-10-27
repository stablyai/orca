import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { ClaudeControlRequestError } from '../../claude/claude-agent-sdk-control-requests'
import { AcpAgentError, AcpRpcError } from '../../acp/acp-errors'
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

function finalAgentStartAnswer(error: Error): boolean {
  if (error instanceof AcpRpcError && !(error instanceof AcpAgentError)) {
    return true
  }
  if (!(error instanceof AcpAgentError || error instanceof CodexAppServerRequestError)) {
    return false
  }
  if (error.code === -32601 || error.code === -32602) {
    return true
  }
  if (
    !(error instanceof CodexAppServerRequestError) ||
    error.method !== 'thread/resume' ||
    error.code !== -32600
  ) {
    return false
  }
  const message =
    error.providerDiagnostic?.text ??
    error.message.replace(/^codex app-server thread\/resume failed: /, '')
  return /^(?:invalid (?:thread|session) id:|thread not found(?::|$)|no rollout found for thread id )/.test(
    message
  )
}

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
    isAgentSessionPreSpawnError(cause) ||
    finalAgentStartAnswer(cause)
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
      cause instanceof AcpAgentError ||
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
