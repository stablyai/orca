/**
 * Keep startup diagnostics specific and ordered. These messages are useful
 * when a partial bootstrap opens a window and are part of the existing contract.
 */
const MAIN_WINDOW_SERVICE_REQUIREMENTS = [
  ['store', 'Store must be initialized before opening the main window'],
  ['runtime', 'Runtime must be initialized before opening the main window'],
  ['stats', 'Stats must be initialized before opening the main window'],
  ['claudeUsage', 'Claude usage store must be initialized before opening the main window'],
  ['codexUsage', 'Codex usage store must be initialized before opening the main window'],
  ['openCodeUsage', 'OpenCode usage store must be initialized before opening the main window'],
  ['rateLimits', 'Rate limit service must be initialized before opening the main window'],
  ['automations', 'Automation service must be initialized before opening the main window'],
  ['codexAccounts', 'Codex account service must be initialized before opening the main window'],
  [
    'codexRuntimeHome',
    'Codex runtime home service must be initialized before opening the main window'
  ],
  ['claudeAccounts', 'Claude account service must be initialized before opening the main window'],
  [
    'claudeRuntimeAuth',
    'Claude runtime auth service must be initialized before opening the main window'
  ],
  ['keybindings', 'Keybinding service must be initialized before opening the main window']
] as const

type MainWindowServiceKey = (typeof MAIN_WINDOW_SERVICE_REQUIREMENTS)[number][0]

type RequiredServices<T extends Record<MainWindowServiceKey, unknown>> = {
  [K in keyof T]: NonNullable<T[K]>
}

export function requireMainWindowServices<T extends Record<MainWindowServiceKey, unknown>>(
  services: T
): RequiredServices<T> {
  for (const [key, message] of MAIN_WINDOW_SERVICE_REQUIREMENTS) {
    if (!services[key]) {
      throw new Error(message)
    }
  }
  return services as RequiredServices<T>
}
