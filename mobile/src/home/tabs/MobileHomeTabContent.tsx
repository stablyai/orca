import type { ScreenHeaderAction } from '../../components/nav-bar/ScreenHeader'
import type { MobileHomeController } from '../use-mobile-home-controller'
import type { HomeTabId } from './home-tabs'
import { MobileHomeAgentsTab } from './MobileHomeAgentsTab'
import { MobileHomeAutomationsTab } from './MobileHomeAutomationsTab'
import { MobileHomeBotsTab } from './MobileHomeBotsTab'
import { MobileHomeFeedTab } from './MobileHomeFeedTab'
import { MobileHomeUsageTab } from './MobileHomeUsageTab'

/** One Home tab's body, drawn the same under the drawn bar and the native one. */
export function MobileHomeTabContent(props: {
  id: HomeTabId
  home: MobileHomeController
  bottomInset: number
  /** The tab's creating action, when the header carries it instead of a floating button. */
  createAction?: ScreenHeaderAction
  onAutomationsHostChange: (hostId: string | null) => void
}) {
  const { home, bottomInset } = props
  switch (props.id) {
    case 'feed':
      return (
        <MobileHomeFeedTab
          data={home.data}
          bottomInset={bottomInset}
          agentHandlers={home.agentHandlers}
          createAction={props.createAction}
          onSeeAllAgents={home.onSeeAllAgents}
          onOpenBot={home.openBot}
          onSeeAllBots={home.onSeeAllBots}
          onOpenHost={home.openHost}
          onOpenHostActions={home.openHostActions}
          onPairDesktop={home.pairDesktop}
          onOpenTasks={home.openTasks}
          onOpenSettings={home.openSettings}
        />
      )
    case 'bots':
      return (
        <MobileHomeBotsTab
          data={home.data}
          bottomInset={bottomInset}
          onNewBot={home.onNewBot}
          onOpenBot={home.openBot}
        />
      )
    case 'agents':
      return (
        <MobileHomeAgentsTab
          data={home.data}
          bottomInset={bottomInset}
          handlers={home.agentHandlers}
        />
      )
    case 'usage':
      return (
        <MobileHomeUsageTab
          hosts={home.data.sortedHosts}
          connectedHosts={home.data.connectedHosts}
          hostStates={home.data.hostStates}
          accountsByHost={home.data.accountsByHost}
          stats={home.data.stats}
          bottomInset={bottomInset}
          onOpenAccounts={home.openMobileAccounts}
        />
      )
    case 'automations':
      return (
        <MobileHomeAutomationsTab
          hosts={home.data.sortedHosts}
          connectedHosts={home.data.connectedHosts}
          hostStates={home.data.hostStates}
          bottomInset={bottomInset}
          createAction={props.createAction}
          onOpenAutomations={(hostId) => home.openMobileAutomations(hostId)}
          onHostChange={props.onAutomationsHostChange}
        />
      )
  }
}
