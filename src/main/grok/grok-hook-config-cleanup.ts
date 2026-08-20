import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  removeManagedCommands,
  type HooksConfig
} from '../agent-hooks/installer-utils'

export type GrokHookConfigCleanup = {
  config: HooksConfig
  removedAny: boolean
}

export function removeManagedGrokHookEntries(
  config: HooksConfig,
  scriptFileName: string
): GrokHookConfigCleanup {
  const nextConfig = { ...config }
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let removedAny = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    if (
      definitions.some((definition) =>
        hookDefinitionHasManagedCommand(definition, isManagedCommand)
      )
    ) {
      removedAny = true
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  if (!removedAny) {
    return { config, removedAny: false }
  }
  if (Object.keys(nextHooks).length === 0) {
    delete nextConfig.hooks
  } else {
    nextConfig.hooks = nextHooks
  }
  return { config: nextConfig, removedAny: true }
}
