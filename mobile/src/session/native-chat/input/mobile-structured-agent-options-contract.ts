import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { StructuredAgentSessionHostSupport } from '../agent-session/mobile-structured-agent-session-host-support'
import type { MobileStructuredAgentMutate } from '../agent-session/use-mobile-structured-agent-mutation'
import type { HostModelCatalogCache } from './use-mobile-host-model-catalog-upgrade'

export type MobileStructuredAgentOptionsArgs = {
  modelCatalogCache?: HostModelCatalogCache | null
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  mutate: MobileStructuredAgentMutate
  onOptionError?: (message: string) => void
  optionStamp?: string
  turnId: string | null
  hasTurn?: boolean
  unloadedTurnRevisions: number | undefined
  hostSupport: Pick<
    StructuredAgentSessionHostSupport,
    | 'permissionModes'
    | 'permissionOwn'
    | 'coherentModelCatalog'
    | 'statusFeed'
    | 'defaultModel'
    | 'modelEffortDiscovery'
    | 'sendSelection'
    | 'sendOptions'
  > | null
}
