import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { structuredLaunchSeedOptions } from '../../../shared/native-chat/input/native-chat-session-option-defaults'
import { isFloatingWorkspaceSelector } from '../../../shared/floating-workspace-worktree'
import { resolveHostStructuredAgentLaunchEnvironment } from '../agent-session/launch/structured-agent-launch-support'
import { structuredAgentRuntimeMetadata } from '../agent-session/installation/structured-agent-runtime-metadata'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../agent-session/structured-agent-session-create-adoption'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './structured-session-create-support'

export abstract class OrcaRuntimeWithStructuredSessionTranscriptAdmission extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  /** A resume's admission proves create could adopt the transcript now, so a terminal close that
   *  stops the agent never precedes create's own missing-history refusal. */
  async assertStructuredAdoptionTranscriptReadable(
    agent: StructuredAgentId,
    worktreeSelector: string,
    providerSessionId: string
  ): Promise<void> {
    const transcriptImport = structuredAgentRuntimeMetadata(agent)?.transcriptImport
    const hostLaunchDirectory = isFloatingWorkspaceSelector(worktreeSelector)
      ? (await this.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
      : undefined
    const resolveAccountHome = this.structuredAgentAccountHomeResolver(
      agent,
      worktreeSelector,
      'launch',
      hostLaunchDirectory
    )
    if (!transcriptImport || !resolveAccountHome) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    await this.accounts.prepareHostAgentLaunch(agent)
    const settings = this.requireStore().getSettings()
    const launchEnv = this.structuredAgentLaunchEnv(agent, settings)
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    const options = structuredLaunchSeedOptions(
      { ...settings, agentLaunchChoices: undefined },
      agent
    )
    await resolveStructuredAgentSessionAdoptionForCreate({
      settings,
      agent,
      transcriptImport,
      providerSessionId,
      resolveTranscriptSource: () => ({ kind: 'none' }),
      selectedAccountHome: await resolveAccountHome(
        { launchEnv, location },
        options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
      ),
      launchEnv: await resolveHostStructuredAgentLaunchEnvironment(agent, settings),
      workspaceCwd: (await this.resolveRuntimeFileTarget(worktreeSelector)).worktree.path,
      conversationName: ''
    })
  }
}
