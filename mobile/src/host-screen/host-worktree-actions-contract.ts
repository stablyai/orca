import type { useRouter } from 'expo-router'
import type { useForgetHostClient } from '../transport/host-client-hooks'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { HostScreenState } from './use-host-screen-state'
import type { ServedProjectSections } from '../worktree/project-sections-operations'

export type HostWorktreeActionsArgs = {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchWorktrees: (options?: { allowDuringModal?: boolean }) => Promise<void>
  forgetHostClient: ReturnType<typeof useForgetHostClient>
  hostCapabilities: readonly string[]
  hostId: string | undefined
  pathname: string
  router: ReturnType<typeof useRouter>
  state: HostScreenState
  projectCatalog?: ServedProjectSections | null
}
