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

// Real rg must serialize over 64 MiB before the later ordinary match reaches the executor.
it('skips an oversized record and keeps a later ordinary match', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'orca-search-record-continuation-'))
  const release = vi.fn()
  try {
    await writeFile(join(rootPath, 'later-hit.txt'), `${'x '.repeat(1_300_000)}\nordinary x\n`)
    const result = await runBundledRipgrepTextSearch({
      rootPath,
      resultRootPath: rootPath,
      options: { rootPath, query: 'x' },
      onSpawn: () => release
    })
    expect(result).toMatchObject({
      totalMatches: 1,
      truncated: true,
      files: [
        {
          filePath: join(rootPath, 'later-hit.txt'),
          matches: [{ line: 2, column: 10, lineContent: 'ordinary x' }]
        }
      ]
    })
    expect(release).toHaveBeenCalledOnce()
  } finally {
    await rm(rootPath, { recursive: true, force: true })
  }
}, 30_000)
