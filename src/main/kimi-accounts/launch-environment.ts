import type { TuiAgent } from '../../shared/tui-agent'

export function applyKimiManagedHomeToLaunchEnv(args: {
  env: Record<string, string> | undefined
  launchAgent: TuiAgent | string | undefined
  connectionId: string | null | undefined
  runtime: 'host' | 'wsl'
  reattached: boolean
  getSelectedManagedHomePath?: () => string | null
}): Record<string, string> | undefined {
  if (
    args.reattached ||
    args.connectionId ||
    args.launchAgent !== 'kimi' ||
    args.runtime !== 'host'
  ) {
    return args.env
  }
  const managedHomePath = args.getSelectedManagedHomePath?.()
  return managedHomePath ? { ...args.env, KIMI_CODE_HOME: managedHomePath } : args.env
}
