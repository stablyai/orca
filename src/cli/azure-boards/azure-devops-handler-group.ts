import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const AZURE_DEVOPS_HANDLER_GROUP: HandlerGroup = {
  name: 'azure-devops',
  keys: [
    'azure-devops pr list',
    'azure-devops pr show',
    'azure-devops pr threads',
    'azure-devops pr checks',
    'azure-devops pr files',
    'azure-devops pr build',
    'azure-devops pr comment',
    'azure-devops pr vote'
  ],
  load: async () => (await import('./azure-devops-pr.js')).AZURE_DEVOPS_PR_HANDLERS
}
