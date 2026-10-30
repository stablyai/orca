import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

const ACCOUNT_SETTINGS = {
  claudeManagedAccounts: 'claude',
  activeClaudeManagedAccountId: 'claude',
  activeClaudeManagedAccountIdsByRuntime: 'claude',
  codexManagedAccounts: 'codex',
  activeCodexManagedAccountId: 'codex',
  activeCodexManagedAccountIdsByRuntime: 'codex'
} satisfies Partial<Record<keyof GlobalSettings, string>>

/** Account changes invalidate probe answers even when the account path stays the same. */
export function expireAgentModelCatalogFailuresForSettings(
  store: Pick<AgentModelCatalogStore, 'expireFailures'>,
  updates: Partial<GlobalSettings>
): void {
  const agents = new Set(
    Object.entries(ACCOUNT_SETTINGS)
      .filter(([key]) => key in updates)
      .map(([, agent]) => agent)
  )
  for (const agent of agents) {
    store.expireFailures(agent)
  }
}

// The settings that pick the binary and environment an agent's probe and chats launch with.
type AgentLaunchSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentCmdOverrides'
    | 'agentDefaultEnv'
    | 'agentDefaultArgs'
    | 'nativeChatInheritShellEnvironment'
    | 'nativeChatShellEnvironmentVariables'
    | 'terminalWindowsShell'
    | 'terminalWindowsPowerShellImplementation'
  >
>

function launchKeys(settings: AgentLaunchSettings): Map<string, string> {
  const commands = new Map<string, string | undefined>(
    Object.entries(settings.agentCmdOverrides ?? {})
  )
  const envs = new Map<string, Record<string, string> | undefined>(
    Object.entries(settings.agentDefaultEnv ?? {})
  )
  const keys = new Map<string, string>()
  for (const agent of new Set([
    ...commands.keys(),
    ...envs.keys(),
    ...Object.keys(settings.agentDefaultArgs ?? {})
  ])) {
    const env = Object.entries(envs.get(agent) ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))
    keys.set(
      agent,
      JSON.stringify([commands.get(agent) ?? null, env, settings.agentDefaultArgs?.[agent]])
    )
  }
  return keys
}

export function agentsWithChangedLaunchSettings(
  previous: AgentLaunchSettings,
  next: AgentLaunchSettings
): string[] {
  const before = launchKeys(previous)
  const after = launchKeys(next)
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (agent) => before.get(agent) !== after.get(agent)
  )
}

/** Account changes expire failures; command/environment changes also expire saved listings. */
export function createAgentModelCatalogSettingsExpiry(
  store: Pick<AgentModelCatalogStore, 'expireFailures' | 'expireAgent' | 'expireLaunchScopes'>,
  initial: AgentLaunchSettings
): (updates: Partial<GlobalSettings>, settings: AgentLaunchSettings) => void {
  let launch = initial
  return (updates, settings) => {
    expireAgentModelCatalogFailuresForSettings(store, updates)
    const environment = (value: AgentLaunchSettings): string =>
      JSON.stringify([
        value.nativeChatInheritShellEnvironment,
        value.nativeChatShellEnvironmentVariables,
        value.terminalWindowsShell,
        value.terminalWindowsPowerShellImplementation
      ])
    if (environment(launch) !== environment(settings)) {
      store.expireLaunchScopes()
    }
    const next = settings
    for (const agent of agentsWithChangedLaunchSettings(launch, next)) {
      store.expireAgent(agent)
    }
    launch = next
  }
}
