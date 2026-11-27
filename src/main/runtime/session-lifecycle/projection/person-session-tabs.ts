// A teammate's own chat tabs on a shared agent's host: which person each paired device calls for, and
// opening, selecting and closing a tab that is theirs alone, never written into the host's list.
import type { MobileSessionTabActivationOptions } from './mobile-session-tab-activation-options'
import type { RuntimeMobileSessionTabActivationResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  committedMobileSessionTabClose,
  type MobileSessionTabCloseOutcome
} from '../close/mobile-session-tab-close-outcome'
import {
  personSessionTabId,
  teammateTabSetKey
} from '../../client/navigation/client-session-person-tabs'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import { moveTeammateHostTabs } from '../../../bots/team-share/teammate-host-tab-move'
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './apply-mobile-session-tab-navigation'

export abstract class OrcaRuntimeWithPersonSessionTabs extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  // Which person each paired device calls for: a teammate's devices share one tab set of their own.
  protected readonly clientSessionPeople = this.clientSessionTabSelections.personTabs.setPeople({
    personOf: (deviceId) => {
      const teammate = this.botShareDevices?.teammateOfDevice(deviceId)
      return teammate ? teammateTabSetKey(teammate) : null
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
    await moveTeammateHostTabs(
      this,
      this.bots.list(),
      this.clientSessionTabSelections.personTabs
    ).catch((error: unknown) =>
      console.warn('[bots] moving teammates’ tabs off the host failed:', error)
    )
  }

  /** A teammate's chat opens in their own tabs, on every device of theirs, never in the host's list;
   *  false for the owner's devices, whose chats open in the host's. */
  async openPersonSessionTabForClient(
    worktreeId: string,
    sessionId: string,
    clientNavigationId: string
  ): Promise<boolean> {
    if (
      !this.clientSessionTabSelections.personTabs.open(clientNavigationId, worktreeId, sessionId)
    ) {
      return false
    }
    const snapshot = await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
      includeAgentSenders: false
    })
    const tab = snapshot.tabs.find(
      (candidate) => candidate.type === 'agent-session' && candidate.sessionId === sessionId
    )
    this.clientSessionTabSelections.reopen(
      this.withSessionTabsHolds(snapshot, clientNavigationId),
      clientNavigationId,
      tab?.id ?? personSessionTabId(sessionId)
    )
    this.createMobileSessionTabsDelivery()(snapshot, ++this.mobileSessionTabsChangeSequence)
    return true
  }

  /** A teammate's own tab closes from their own tabs alone; null for any other tab, which the host's
   *  close decides (a chat the host also has a tab for shows as the host's). */
  async closePersonSessionTab(
    worktreeSelector: string,
    tabId: string,
    clientNavigationId: string
  ): Promise<MobileSessionTabCloseOutcome | null> {
    const worktreeId = await this.resolveSessionWorktreeId(worktreeSelector)
    const hostHas = this.mobileSessionTabsByWorktree
      .get(worktreeId)
      ?.tabs.some(
        (tab) =>
          tab.id === tabId ||
          (tab.type === 'agent-session' && personSessionTabId(tab.sessionId) === tabId)
      )
    if (!this.clientSessionTabSelections.personTabs.close(clientNavigationId, worktreeId, tabId)) {
      return null
    }
    await this.deliverPersonTabs(worktreeId)
    return hostHas
      ? null
      : committedMobileSessionTabClose(this.clientSessionTabSelections, worktreeId, [])
  }

  /** Selecting a teammate's own tab moves only the caller: no one else has it. */
  override async activateMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    leafId?: string,
    opts: MobileSessionTabActivationOptions = {}
  ): Promise<RuntimeMobileSessionTabActivationResult> {
    const worktreeId = opts.clientNavigationId
      ? await this.resolveSessionWorktreeId(worktreeSelector)
      : null
    const own =
      worktreeId && opts.clientNavigationId && !leafId
        ? this.clientSessionTabSelections.personTabs.tabOf(
            opts.clientNavigationId,
            worktreeId,
            tabId
          )
        : null
    const hostHas = this.mobileSessionTabsByWorktree
      .get(worktreeId ?? '')
      ?.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === own?.sessionId)
    if (!worktreeId || !own || hostHas) {
      return super.activateMobileSessionTab(worktreeSelector, tabId, leafId, opts)
    }
    opts.beforeActivate?.({ sessionId: own.sessionId, worktreeId })
    return this.applyMobileSessionTabNavigation(
      await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
        includeAgentSenders: opts.includeAgentSenders
      }),
      own.id,
      'caller',
      opts.clientNavigationId
    )
  }

  private async resolveSessionWorktreeId(worktreeSelector: string): Promise<string> {
    return (
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    )
  }

  /** Every listener re-projects, so each device of the person redraws its own tabs. */
  private async deliverPersonTabs(worktreeId: string): Promise<void> {
    this.createMobileSessionTabsDelivery()(
      await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
        includeAgentSenders: false
      }),
      ++this.mobileSessionTabsChangeSequence
    )
  }
}
