import type { MobileWebTaskBootstrapResult } from '../../../src/shared/mobile-web/task-read-contract'
import type { HostTaskBootstrap } from '../tasks/host-task-read-operations'

const HOSTED_TASK_PROVIDERS = ['github', 'gitlab', 'linear'] as const

export function mobileWebTaskSettings(
  settings: HostTaskBootstrap['settings'],
  pageRepoId: (hostRepoId: string) => string | null
): MobileWebTaskBootstrapResult['settings'] {
  const visibleTaskProviders = HOSTED_TASK_PROVIDERS.filter((provider) =>
    settings.visibleTaskProviders?.includes(provider)
  )
  const supportedProviders =
    visibleTaskProviders.length > 0 ? visibleTaskProviders : [...HOSTED_TASK_PROVIDERS]
  const defaultTaskSource = HOSTED_TASK_PROVIDERS.find(
    (provider) => provider === settings.defaultTaskSource
  )
  return {
    defaultTuiAgent: settings.defaultTuiAgent,
    disabledTuiAgents: settings.disabledTuiAgents,
    agentCmdOverrides: settings.agentCmdOverrides,
    defaultTaskSource:
      defaultTaskSource && supportedProviders.includes(defaultTaskSource)
        ? defaultTaskSource
        : supportedProviders[0],
    defaultTaskViewPreset: settings.defaultTaskViewPreset,
    visibleTaskProviders: supportedProviders,
    defaultRepoSelection:
      settings.defaultRepoSelection === null
        ? null
        : settings.defaultRepoSelection
            ?.flatMap((hostRepoId) => {
              const id = pageRepoId(hostRepoId)
              return id ? [id] : []
            })
            .slice(0, 10_000),
    defaultLinearTeamSelection: settings.defaultLinearTeamSelection,
    githubProjects: settings.githubProjects
  }
}
