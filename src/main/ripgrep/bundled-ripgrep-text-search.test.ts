import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runBundledRipgrepTextSearch } from './bundled-ripgrep-text-search'

it('runs the bundled binary, bounds results and releases process ownership once', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'orca-text-search-'))
  const resultRootPath = join(rootPath, 'lexical-root')
  const release = vi.fn()
  try {
    await writeFile(join(rootPath, 'example.txt'), 'é needle\r\n'.repeat(100))
    const result = await runBundledRipgrepTextSearch({
      rootPath,
      resultRootPath,
      options: { rootPath: resultRootPath, query: 'needle', maxResults: 2 },
      onSpawn: () => release
    })
    expect(result).toMatchObject({
      totalMatches: 2,
      truncated: true,
      files: [
        {
          filePath: join(resultRootPath, 'example.txt'),
          relativePath: 'example.txt',
          matches: [
            { line: 1, column: 3 },
            { line: 2, column: 3 }
          ]
        }
      ]
    })
    expect(release).toHaveBeenCalledOnce()
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
})
