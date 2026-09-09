import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { GitignoreTemplateFileCache } from '../gitignore/gitignore-template-file-cache'
import { GitHubGitignoreTemplateService } from '../gitignore/github-gitignore-template-service'
import { getMainHttpClient } from '../network/http-client'

export function registerGitignoreTemplateHandlers(): void {
  const cache = new GitignoreTemplateFileCache(
    join(app.getPath('userData'), 'gitignore-templates', 'github-gitignore.json')
  )
  const service = new GitHubGitignoreTemplateService({
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    cache
  })
  ipcMain.handle('gitignore-templates:list', () => service.list())
  ipcMain.handle('gitignore-templates:get', (_event, name: string) => service.get(name))
}
