import type { HandlerGroup } from './handler-group-manifest'

// Why split out: keeps handler-group-manifest.ts under the file-length cap as repo commands grow.
export const REPO_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'repo',
    keys: [
      'repo list',
      'repo add',
      'repo show',
      'repo set',
      'repo set-theme',
      'repo set-base-ref',
      'repo search-refs'
    ],
    load: async () => (await import('./handlers/repo.js')).REPO_HANDLERS
  }
]
