import type { ManagedCliHomeProvider } from '../../shared/managed-account-types'

const ENV_KEYS: Record<ManagedCliHomeProvider, 'GROK_HOME' | 'GEMINI_CLI_HOME'> = {
  grok: 'GROK_HOME',
  gemini: 'GEMINI_CLI_HOME'
}

export function applyManagedProviderHomeToLaunchEnv(args: {
  provider: ManagedCliHomeProvider
  env: Record<string, string> | undefined
  launchAgent: string | undefined
  connectionId: string | null | undefined
  runtime: 'host' | 'wsl'
  reattached: boolean
  getSelectedManagedHomePath?: () => string | null
}): Record<string, string> | undefined {
  if (
    args.reattached ||
    args.connectionId ||
    args.launchAgent !== args.provider ||
    args.runtime !== 'host'
  ) {
    return args.env
  }
  const managedHomePath = args.getSelectedManagedHomePath?.()
  return managedHomePath ? { ...args.env, [ENV_KEYS[args.provider]]: managedHomePath } : args.env
}
