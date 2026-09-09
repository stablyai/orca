import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GitignoreTemplateCache } from '../../shared/gitignore-templates'

const updateQueues = new Map<string, Promise<void>>()

function emptyCache(): GitignoreTemplateCache {
  return { templates: {} }
}

export class GitignoreTemplateFileCache {
  constructor(private readonly filePath: string) {}

  async read(): Promise<GitignoreTemplateCache | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as GitignoreTemplateCache
      if (!value || typeof value !== 'object' || !value.templates) {
        return null
      }
      return value
    } catch {
      return null
    }
  }

  private async write(cache: GitignoreTemplateCache): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(cache), 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  async update(
    mutate: (cache: GitignoreTemplateCache) => GitignoreTemplateCache
  ): Promise<GitignoreTemplateCache> {
    const previous = updateQueues.get(this.filePath) ?? Promise.resolve()
    let result = emptyCache()
    const operation = previous.then(async () => {
      result = mutate((await this.read()) ?? emptyCache())
      await this.write(result)
    })
    const queued = operation.catch(() => {})
    updateQueues.set(this.filePath, queued)
    try {
      await operation
    } finally {
      if (updateQueues.get(this.filePath) === queued) {
        updateQueues.delete(this.filePath)
      }
    }
    return result
  }
}
