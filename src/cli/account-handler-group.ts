import type { HandlerGroup } from './handler-group-manifest'

export const ACCOUNT_HANDLER_GROUP: HandlerGroup = {
  name: 'account',
  keys: [
    'account add',
    'account list',
    'account select',
    'account rm',
    'account auth-proxy',
    'account auto-switch',
    'account moves',
    'account pool',
    'account session-mover'
  ],
  load: async () => (await import('./handlers/account.js')).ACCOUNT_HANDLERS
}
