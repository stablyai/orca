import { describe, expect, it, vi } from 'vitest'
import {
  readBlobAtIndex,
  readBlobAtOid,
  readUnstagedLeft,
  type GitBufferExec
} from './git-handler-ops'

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

  it('marks OID blobs that overflow maxBuffer as binary', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockRejectedValue(
      Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ENOBUFS',
        killed: true,
        signal: 'SIGTERM'
      })
    )

    const result = await readBlobAtOid(gitBuffer, '/repo', 'HEAD', 'large.log')

    expect(result).toEqual({ content: '', isBinary: true })
  })

  it('normalizes Windows separators before reading index blobs', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockResolvedValue(Buffer.from('index-content'))

    const result = await readBlobAtIndex(gitBuffer, '/repo', 'src\\file.ts')

    expect(gitBuffer).toHaveBeenCalledWith(['show', '--end-of-options', ':src/file.ts'], '/repo')
    expect(result.content).toBe('index-content')
  })

  it('marks index blobs that overflow maxBuffer as binary', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockRejectedValue(
      Object.assign(new Error('git stdout exceeded maxBuffer.'), {
        code: 'ENOBUFS',
        killed: true,
        signal: 'SIGTERM'
      })
    )

    const result = await readBlobAtIndex(gitBuffer, '/repo', 'large.log')

    // Why: overflow is size-capped content, not a staged deletion (missing: false).
    expect(result).toEqual({ content: '', isBinary: true, missing: false })
  })

  it('does not spawn a HEAD read for a successfully read empty index blob', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockResolvedValue(Buffer.alloc(0))

    const result = await readUnstagedLeft(gitBuffer, '/repo', 'empty.txt')

    expect(result.content).toBe('')
    expect(gitBuffer).toHaveBeenCalledExactlyOnceWith(
      ['show', '--end-of-options', ':empty.txt'],
      '/repo'
    )
  })
})
