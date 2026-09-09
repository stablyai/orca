import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GitignoreTemplateCache } from '../../shared/gitignore-templates'

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

  async write(cache: GitignoreTemplateCache): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(cache), 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}
