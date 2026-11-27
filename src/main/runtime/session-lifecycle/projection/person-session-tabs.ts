// A teammate's own chat tabs on a shared agent's host: which person each paired device calls for, what
// of the agent's home it is shown, and publishing a change to their tab set to every device of theirs.
import { teammateTabSetKey } from '../../client/navigation/client-session-person-tabs'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { moveTeammateHostTabs } from '../../../bots/team-share/teammate-host-tab-move'
import { teammateSessionTabs } from '../../../bots/team-share/teammate-workspace-view'
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './apply-mobile-session-tab-navigation'

export abstract class OrcaRuntimeWithPersonSessionTabs extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  protected readonly clientSessionPeople = this.clientSessionTabSelections.personTabs.setPeople({
    personOf: (deviceId) => {
      const teammate = this.botShareDevices?.teammateOfDevice(deviceId)
      const bot = teammate && this.bots.list().find((entry) => entry.id === teammate.botId)
      if (!teammate || !bot) {
        return null
      }
      const home = folderWorkspaceKey(bot.folderWorkspaceId)
      const scope = { kind: 'bot-share' as const, ...teammate, name: '' }
      return {
        key: teammateTabSetKey(teammate),
        home,
        hostTabs: teammateSessionTabs(this, scope, home)
      }
    },
    tabOf: (worktreeId, sessionId) => {
      const record = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
      return record?.location.workspaceId === worktreeId
        ? {
            agent: record.provider,
            title: record.conversationName ?? defaultAgentChatLabel(record.provider)
          }
        : null
    }
  })

  protected override async backfillBotBackgroundChats(): Promise<void> {
    await super.backfillBotBackgroundChats()
    await moveTeammateHostTabs(this, this.bots.list(), this.clientSessionTabSelections.personTabs)
      .then((moved) =>
        Promise.all(moved.map((worktreeId) => this.publishPersonSessionTabs(worktreeId)))
      )
      .catch((error: unknown) =>
        console.warn('[bots] moving teammates’ tabs off the host failed:', error)
      )
  }
}
