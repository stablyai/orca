import { moveTeammateHostTabs } from '../../../bots/team-share/teammate-host-tab-move'
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../publication/session-tabs-change-publication'

export abstract class OrcaRuntimeWithTeammateHomeTabMove extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
  /** Once the chat host is up: teammates' tabs an older build saved in the host's list move to theirs. */
  protected override async backfillBotBackgroundChats(): Promise<void> {
    await super.backfillBotBackgroundChats()
    await moveTeammateHostTabs(this, this.store?.getBots?.() ?? [], this.personSessionTabs)
      .then((moved) =>
        moved.forEach(({ person, worktreeId }) => this.publishPersonSessionTabs(person, worktreeId))
      )
      .catch((error: unknown) =>
        console.warn('[bots] moving teammates’ tabs off the host failed:', error)
      )
  }
}
