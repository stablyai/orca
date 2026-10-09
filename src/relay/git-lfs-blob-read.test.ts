import { describe, expect, it, vi } from 'vitest'
import {
  readBlobAtIndex,
  readBlobAtOid,
  readUnstagedLeft,
  type GitBufferExec
} from './git-handler-ops'

const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x0a])
const pointer = Buffer.from(
  `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 7\n`
)
const unmerged = Buffer.from(`100644 ${'a'.repeat(40)} 2\timage.png\0`)

describe('relay Git LFS previews', () => {
  it('resolves historical pointers on the same owning runtime using stdin', async () => {
    const git = vi.fn<GitBufferExec>().mockResolvedValueOnce(pointer).mockResolvedValueOnce(image)
    expect(await readBlobAtOid(git, '/repo', 'HEAD~1', 'image.png')).toEqual({
      content: image.toString('base64'),
      isBinary: true
    })
    expect(git).toHaveBeenLastCalledWith(
      ['-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge', '--', 'image.png'],
      '/repo',
      { stdin: pointer.toString('utf8') }
    )
  })

  it('does not mark filter authentication failures as deleted images', async () => {
    const git = vi
      .fn<GitBufferExec>()
      .mockRejectedValueOnce(Object.assign(new Error('Synthetic HTTP 403'), { code: 128 }))
      .mockResolvedValueOnce(Buffer.from(`100644 ${'a'.repeat(40)} 0\timage.png\0`))
    expect(await readBlobAtIndex(git, '/repo', 'image.png')).toEqual({
      content: '',
      isBinary: true,
      missing: false
    })
  })

  it('does not mark an unmerged image as a staged deletion', async () => {
    const git = vi
      .fn<GitBufferExec>()
      .mockRejectedValueOnce(new Error('Synthetic conflict'))
      .mockResolvedValueOnce(unmerged)
    expect(await readBlobAtIndex(git, '/repo', 'image.png')).toEqual({
      content: '',
      isBinary: true,
      missing: false,
      unmerged: true
    })
  })

  it('reads HEAD as the original preview for unmerged images', async () => {
    const git = vi
      .fn<GitBufferExec>()
      .mockRejectedValueOnce(new Error('Synthetic conflict'))
      .mockResolvedValueOnce(unmerged)
      .mockResolvedValueOnce(image)
    expect(await readUnstagedLeft(git, '/repo', 'image.png')).toEqual({
      content: image.toString('base64'),
      isBinary: true
    })
    expect(git).toHaveBeenLastCalledWith(['cat-file', '--filters', '--', 'HEAD:image.png'], '/repo')
  })
})
