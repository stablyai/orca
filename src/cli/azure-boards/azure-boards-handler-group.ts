import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const AZURE_BOARDS_HANDLER_GROUP: HandlerGroup = {
  name: 'azure-boards',
  keys: [
    'azure-boards connection',
    'azure-boards item',
    'azure-boards comment list',
    'azure-boards search',
    'azure-boards assigned',
    'azure-boards team list'
  ],
  load: async () => (await import('./azure-boards.js')).AZURE_BOARDS_HANDLERS
}
