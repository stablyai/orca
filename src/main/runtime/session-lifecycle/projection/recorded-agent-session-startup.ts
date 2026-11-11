import type { PaneResumeStartup } from './agent-session-resume-ownership'
import type { RecordedAgentSessionIdentity } from '../../../../shared/agent-session/recorded-agent-session'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

export function requireRecordedResumeStartup(
  startup: PaneResumeStartup | Record<string, never> | undefined,
  expected: RecordedAgentSessionIdentity | undefined
): void {
  if (!expected) {
    return
  }
  if (
    startup &&
    'resumeProviderSession' in startup &&
    startup.launchAgent === expected.agent &&
    agentProviderSessionsEqual(
      expected.agent,
      startup.resumeProviderSession,
      expected.providerSession
    )
  ) {
    return
  }
  if (startup && 'resumeClaim' in startup) {
    startup.resumeClaim.settleFailure(false)
  }
  throw new Error('agent_session_resume_not_authorized')
}

export function bindRecordedResumePty(
  startup: PaneResumeStartup | Record<string, never> | undefined,
  ptyId: string,
  result: RuntimeTerminalCreate
): RecordedAgentSessionIdentity | undefined {
  if (!startup || !('resumeClaim' in startup)) {
    return undefined
  }
  const decision = result.savedResumeDecision
  if (
    !result.isReattach &&
    result.agentSessionDisposition !== 'adopted' &&
    decision &&
    decision.agent === startup.launchAgent &&
    decision.verdict !== 'admitted' &&
    decision.verdict === result.agentResumeRefused &&
    agentProviderSessionsEqual(
      decision.agent,
      decision.providerSession,
      startup.resumeProviderSession
    )
  ) {
    startup.resumeClaim.settleFailure(false)
    return undefined
  }
  startup.resumeClaim.bind(ptyId)
  return !result.agentResumeRefused && startup.launchAgent && startup.resumeProviderSession
    ? { agent: startup.launchAgent, providerSession: startup.resumeProviderSession }
    : undefined
}
