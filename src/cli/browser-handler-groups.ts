import { ORCA_BROWSER_CLI_COMMAND_KEYS } from '../shared/orca-browser-cli-commands'
import type { HandlerGroup } from './handler-group-manifest'

export const BROWSER_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'browser-identity',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-identity'],
    load: async () => (await import('./handlers/browser-identity.js')).BROWSER_IDENTITY_HANDLERS
  },
  {
    name: 'browser-nav',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-nav'],
    load: async () => (await import('./handlers/browser-nav.js')).BROWSER_NAV_HANDLERS
  },
  {
    name: 'browser-interact',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-interact'],
    load: async () => (await import('./handlers/browser-interact.js')).BROWSER_INTERACT_HANDLERS
  },
  {
    name: 'browser-tab',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-tab'],
    load: async () => (await import('./handlers/browser-tab.js')).BROWSER_TAB_HANDLERS
  },
  {
    name: 'browser-profile',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-profile'],
    load: async () => (await import('./handlers/browser-profile.js')).BROWSER_PROFILE_HANDLERS
  },
  {
    name: 'browser-cookie',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-cookie'],
    load: async () => (await import('./handlers/browser-cookie.js')).BROWSER_COOKIE_HANDLERS
  },
  {
    name: 'browser-capture',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-capture'],
    load: async () => (await import('./handlers/browser-capture.js')).BROWSER_CAPTURE_HANDLERS
  },
  {
    name: 'browser-env',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-env'],
    load: async () => (await import('./handlers/browser-env.js')).BROWSER_ENV_HANDLERS
  },
  {
    name: 'browser-storage',
    keys: ORCA_BROWSER_CLI_COMMAND_KEYS['browser-storage'],
    load: async () => (await import('./handlers/browser-storage.js')).BROWSER_STORAGE_HANDLERS
  }
]
