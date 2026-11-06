import type { HandlerGroup } from './handler-group-manifest'

export const REPO_HANDLER_GROUP: HandlerGroup = {
  name: 'repo',
  keys: [
    'repo list',
    'repo add',
    'repo show',
    'repo set',
    'repo set-base-ref',
    'repo delete-branch',
    'repo search-refs'
  ],
  load: async () => (await import('./handlers/repo.js')).REPO_HANDLERS
}
