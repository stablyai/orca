import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { searchWithGitGrep } from './fs-handler-git-search'
import { GitGrepRecordCapacityError } from '../shared/git-grep-record-limit'

describe('real git search capacity and recovery', () => {
  it('rejects a matching newline-free file and can search again in the same folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-record-'))
    try {
      await runProcess({ program: 'git', args: ['init', '--quiet'], cwd: root })
      await writeFile(join(root, 'record.txt'), `needle${'x'.repeat(9 * 1024 * 1024)}`)
      await expect(searchWithGitGrep(root, 'needle', { maxResults: 10 })).rejects.toThrow(
        GitGrepRecordCapacityError
      )
      await writeFile(join(root, 'record.txt'), 'needle\n')
      expect((await searchWithGitGrep(root, 'needle', { maxResults: 10 })).totalMatches).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
