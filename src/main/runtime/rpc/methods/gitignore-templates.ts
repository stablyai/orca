import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { GitignoreTemplateFileCache } from '../../../gitignore/gitignore-template-file-cache'
import { GitHubGitignoreTemplateService } from '../../../gitignore/github-gitignore-template-service'
import { getMainHttpClient } from '../../../network/http-client'
import { defineMethod, type RpcMethod } from '../core'

let service: GitHubGitignoreTemplateService | null = null

function getService(): GitHubGitignoreTemplateService {
  service ??= new GitHubGitignoreTemplateService({
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    cache: new GitignoreTemplateFileCache(
      join(
        getAppEnvironment().getPath('userData'),
        'gitignore-templates',
        'github-gitignore.json'
      )
    )
  })
  return service
}

export const GITIGNORE_TEMPLATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'gitignoreTemplates.list',
    params: null,
    handler: async (_params, { signal }) => getService().list(signal)
  }),
  defineMethod({
    name: 'gitignoreTemplates.get',
    params: z.object({ name: z.string().min(1).max(110) }),
    handler: async (params, { signal }) => getService().get(params.name, signal)
  })
]
