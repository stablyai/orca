import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { structuredLaunchSeedOptions } from '../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../../agent-session/installation/structured-agent-runtime-metadata'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../agent-session/launch/structured-agent-launch-support'
import { findStructuredAgentSessionAdoptionTranscript } from '../../agent-session/ownership/structured-agent-session-adoption-transcript'
import {
  resolveAdoptedTranscriptFolder,
  adoptionChecksFolder
} from '../../../native-chat/agent-session-journal/history-import/adopted-transcript-source'
import { StructuredSessionWorkspaceScope } from './structured-session-workspace-scope'

export abstract class OrcaRuntimeWithStructuredResumeFolderCheck extends StructuredSessionWorkspaceScope {
  /** Create's other-folder refusal for a resume, asked before a client closes the terminal running
   *  the conversation. Finds the transcript as create does; anything else is left to create. */
  async assertStructuredAdoptionFolder(
    worktreeSelector: string,
    agent: StructuredAgentId,
    providerSessionId: string
  ): Promise<void> {
    if (!adoptionChecksFolder(agent)) {
      return
    }
    const found = await this.findStructuredResumeTranscript(
      worktreeSelector,
      agent,
      providerSessionId
    ).catch(() => null)
    if (found) {
      await resolveAdoptedTranscriptFolder({
        agent,
        filePath: found.transcriptPath,
        source: { providerSessionId, workspaceCwd: found.workspaceCwd }
      })
    }
  }

  private async findStructuredResumeTranscript(
    worktreeSelector: string,
    agent: StructuredAgentId,
    providerSessionId: string
  ): Promise<{ transcriptPath: string; workspaceCwd: string } | null> {
    const transcriptImport = structuredAgentRuntimeMetadata(agent)?.transcriptImport
    const resolveAccountHome = this.structuredAgentAccountHomeResolver(
      agent,
      worktreeSelector,
      'launch'
    )
    if (!transcriptImport || !resolveAccountHome) {
      return null
    }
    await this.accounts.prepareHostAgentLaunch(agent)
    const settings = this.requireStore().getSettings()
    const launchEnv = this.structuredAgentLaunchEnv(agent, settings)
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    const workspaceCwd = (await this.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
    const permissionMode = structuredLaunchSeedOptions(
      { ...settings, agentLaunchChoices: undefined },
      agent
    )?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
    const { adoption } = await findStructuredAgentSessionAdoptionTranscript({
      settings,
      agent,
      transcriptImport,
      providerSessionId,
      selectedAccountHome: await resolveAccountHome({ launchEnv, location }, permissionMode),
      launchEnv: await resolveHostStructuredAgentLaunchEnvironment(agent, settings),
      workspaceCwd
    })
    return { transcriptPath: adoption.transcriptPath, workspaceCwd }
  }
}
