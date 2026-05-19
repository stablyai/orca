import { describe, expect, it, vi } from 'vitest'
import { readBlobAtIndex, readBlobAtOid, type GitBufferExec } from './git-handler-ops'

describe('git blob readers', () => {
  it('normalizes Windows separators before reading OID blobs', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockResolvedValue(Buffer.from('head-content'))

    const result = await readBlobAtOid(gitBuffer, '/repo', 'HEAD', 'src\\file.ts')

    expect(gitBuffer).toHaveBeenCalledWith(
      ['show', '--end-of-options', 'HEAD:src/file.ts'],
      '/repo'
    )
    expect(result.content).toBe('head-content')
  })

  it('normalizes Windows separators before reading index blobs', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockResolvedValue(Buffer.from('index-content'))

    const result = await readBlobAtIndex(gitBuffer, '/repo', 'src\\file.ts')

    expect(gitBuffer).toHaveBeenCalledWith(['show', '--end-of-options', ':src/file.ts'], '/repo')
    expect(result.content).toBe('index-content')
  })
})
