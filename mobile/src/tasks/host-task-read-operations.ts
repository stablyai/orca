import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type {
  MobileWebTaskBootstrapResult,
  MobileWebTaskLinearContextResult,
  MobileWebTaskRepositoriesResult
} from '../../../src/shared/mobile-web/task-read-contract'

type HostTaskRuntimeSettings = Omit<
  MobileWebTaskBootstrapResult['settings'],
  'defaultTuiAgent' | 'disabledTuiAgents' | 'defaultTaskSource' | 'visibleTaskProviders'
> & {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
  defaultTaskSource?: TaskProvider
  visibleTaskProviders?: TaskProvider[]
}

export type HostTaskBootstrap = Omit<MobileWebTaskBootstrapResult, 'settings'> & {
  settings: HostTaskRuntimeSettings
}
export type HostTaskRepository = MobileWebTaskRepositoriesResult['repositories'][number]
export type HostTaskLinearContext = MobileWebTaskLinearContextResult

export type HostTaskReadOperations = {
  bootstrap(): Promise<HostTaskBootstrap>
  listRepositories(): Promise<HostTaskRepository[]>
  loadLinearContext(): Promise<HostTaskLinearContext>
  resolveGitHubRepoSlug(repoId: string): Promise<GitHubOwnerRepo | null>
}
