import type { TuiAgent } from '../../shared/tui-agent'

export function applyCommandCodeManagedCredentialToLaunchEnv(args: {
  env: Record<string, string> | undefined
  launchAgent: TuiAgent | string | undefined
  connectionId: string | null | undefined
  runtime: 'host' | 'wsl'
  reattached: boolean
  getSelectedApiKey?: () => string | null
}): Record<string, string> | undefined {
  if (
    args.reattached ||
    args.connectionId ||
    args.launchAgent !== 'command-code' ||
    args.runtime !== 'host'
  ) {
    return args.env
  }
  const apiKey = args.getSelectedApiKey?.()
  return apiKey ? { ...args.env, COMMAND_CODE_API_KEY: apiKey } : args.env
}
