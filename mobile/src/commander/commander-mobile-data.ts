import type { AgentListRowHandlers } from '../agents/MobileAgentListRows'
import type { MobileHomeData } from '../home/use-mobile-home-data'
export type CommanderMobileData = {
  sortedHosts: readonly { id: string; name: string }[]
  agentList: MobileHomeData['agentList']
  hostStates: MobileHomeData['hostStates']
  allClients: readonly { hostId: string; client: MobileHomeData['allClients'][number]['client'] }[]
}

export type CommanderOverviewProps = {
  data: CommanderMobileData
  handlers: Pick<AgentListRowHandlers, 'onOpen'>
  active: boolean
  hostScoped?: boolean
}
