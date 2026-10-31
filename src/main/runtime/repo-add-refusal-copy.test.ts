import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeNonGitRepoAddRefusal } from './repo-add-refusal-copy'

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'orca-repo-add-refusal-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('describeNonGitRepoAddRefusal', () => {
  it('keeps the renderer-matched prefix and points at --kind folder', async () => {
    await withTempDir(async (path) => {
      const message = await describeNonGitRepoAddRefusal(path)

      expect(message.startsWith(`Not a valid git repository: ${path}`)).toBe(true)
      expect(message).toContain('--kind folder')
      expect(message).not.toContain('.repo/manifest.xml')
    })
  })

  it('names a repo-tool checkout when .repo/manifest.xml exists', async () => {
    await withTempDir(async (path) => {
      await mkdir(join(path, '.repo'))
      await writeFile(join(path, '.repo', 'manifest.xml'), '<manifest/>')

      const message = await describeNonGitRepoAddRefusal(path)

      expect(message.startsWith(`Not a valid git repository: ${path}`)).toBe(true)
      expect(message).toContain('repo-tool checkout (.repo/manifest.xml)')
      expect(message).toContain('Use --kind folder')
    })
  })
})
