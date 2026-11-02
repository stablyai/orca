import type { HandlerGroup } from './handler-group-manifest'

export const ACCOUNT_HANDLER_GROUP: HandlerGroup = {
  name: 'account',
  keys: [
    'account add',
    'account list',
    'account select',
    'account rm',
    'account auto-switch',
    'account token-refresh'
  ],
  load: async () => (await import('./handlers/account.js')).ACCOUNT_HANDLERS
}
