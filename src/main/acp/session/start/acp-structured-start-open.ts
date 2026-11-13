import { withProviderDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'
import '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenInput } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { acpAgentName } from '../acp-structured-agent-definitions'
import { acpStartupFailure } from '../children/acp-structured-child'
import type { AcpStructuredChildren } from '../children/acp-structured-child-lifecycle'
import { acpStartFailure } from './acp-startup-outcome'
import { withAcpStartupDiagnostic } from './acp-startup-diagnostic'

/** A start's open answers with the agent's verdict; a child that already ended answers with how
 *  it ended, and an answer its own exit followed is still worded as that exit. */
export async function openAcpStart(
  children: AcpStructuredChildren,
  input: StructuredAgentSessionProviderOpenInput
): ReturnType<NonNullable<StructuredAgentSessionAdapter['open']>> {
  const child = children.sessions.get(input.sessionId)
  try {
    if (
      !child ||
      child.fence !== input.fence ||
      child.acquisitionGeneration !== input.acquisitionGeneration ||
      child.ended
    ) {
      throw (
        children.endings.get(input.sessionId, input.acquisitionGeneration) ??
        new Error('ACP child changed before it opened')
      )
    }
    return await child.open(input.signal).catch((error: unknown) => {
      const failure = acpStartupFailure(child, error)
      if (!failure) {
        throw error
      }
      const refusal = new AgentSessionAcquisitionRefusal(
        `${acpAgentName(child.spec.agent)} requires sign-in`,
        'notSignedIn',
        failure.account
      )
      throw failure.detail ? withProviderDiagnostic(refusal, failure.detail) : refusal
    })
  } catch (error) {
    if (child) {
      withAcpStartupDiagnostic(error, child.connection, child.spec.dialect)
    }
    throw acpStartFailure(error, child?.connection.exited === true && !child.closeRequested)
  }
}
