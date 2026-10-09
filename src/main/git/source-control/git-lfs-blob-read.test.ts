import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'

const { gitBuffer } = vi.hoisted(() => ({ gitBuffer: vi.fn() }))
vi.mock('../runner', () => ({ gitExecFileAsyncBuffer: gitBuffer }))

import { readGitBlobAtIndexPath, readGitBlobAtOidPath, readUnstagedLeftBlob } from './git-blob-read'

const pointer = Buffer.from(
  `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 7\n`
)
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x0a])

describe('desktop Git LFS blob previews', () => {
  beforeEach(() => {
    gitBuffer.mockReset()
  })

  it('reads filtered index bytes on the same owning WSL runtime', async () => {
    gitBuffer.mockResolvedValue({ stdout: image })
    const result = await readGitBlobAtIndexPath('/repo', 'assets\\image.png', {
      wslDistro: 'Ubuntu'
    })
    expect(result).toEqual({ content: image.toString('base64'), isBinary: true, exists: true })
    expect(gitBuffer).toHaveBeenCalledWith(
      ['cat-file', '--filters', '--', ':assets/image.png'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu', maxBuffer: MAX_GIT_SHOW_BYTES })
    )
  })

  it('resolves historical pointers after attribute removal while preserving the output limit', async () => {
    gitBuffer.mockResolvedValueOnce({ stdout: pointer }).mockResolvedValueOnce({ stdout: image })
    const result = await readGitBlobAtOidPath('/repo', 'HEAD~1', 'image.png')
    expect(result.content).toBe(image.toString('base64'))
    expect(gitBuffer).toHaveBeenLastCalledWith(
      ['-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge', '--', 'image.png'],
      expect.objectContaining({
        cwd: '/repo',
        stdin: pointer.toString('utf8'),
        maxBuffer: MAX_GIT_SHOW_BYTES
      })
    )
  })

  it('does not treat an authentication failure as a missing historical image', async () => {
    gitBuffer
      .mockRejectedValueOnce(Object.assign(new Error('Synthetic HTTP 403'), { code: 128 }))
      .mockResolvedValueOnce({ stdout: Buffer.from('100644 blob synthetic\timage.png\0') })
    expect(await readGitBlobAtOidPath('/repo', 'HEAD', 'image.png')).toEqual({
      content: '',
      isBinary: true,
      exists: true,
      failed: true
    })
  })

  it('marks an image missing only when its index listing proves absence', async () => {
    gitBuffer
      .mockRejectedValueOnce(
        Object.assign(new Error('Synthetic missing index blob'), { code: 128 })
      )
      .mockResolvedValueOnce({ stdout: Buffer.alloc(0) })
    expect(await readGitBlobAtIndexPath('/repo', 'image.png')).toEqual({
      content: '',
      isBinary: false,
      exists: false,
      failed: false
    })
  })

  it('keeps an unavailable presence probe as a read failure', async () => {
    gitBuffer.mockRejectedValue(new Error('Synthetic disconnected runtime'))
    expect(await readGitBlobAtIndexPath('/repo', 'image.png')).toEqual({
      content: '',
      isBinary: true,
      exists: true,
      failed: true
    })
  })

  it('keeps size-capped image content present without performing another Git read', async () => {
    gitBuffer.mockRejectedValue(
      Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' })
    )
    expect(await readGitBlobAtIndexPath('/repo', 'image.png')).toEqual({
      content: '',
      isBinary: true,
      exists: true
    })
    expect(gitBuffer).toHaveBeenCalledTimes(1)
  })

  it('keeps text blob reads unfiltered', async () => {
    gitBuffer.mockResolvedValue({ stdout: Buffer.from('plain text') })
    expect((await readGitBlobAtOidPath('/repo', 'HEAD', 'notes.txt')).content).toBe('plain text')
    expect(gitBuffer).toHaveBeenCalledWith(
      ['show', '--end-of-options', 'HEAD:notes.txt'],
      expect.any(Object)
    )
  })

  it('falls back to HEAD for unmerged images without proving a staged deletion', async () => {
    const conflict = Buffer.from(`100644 ${'a'.repeat(40)} 2\timage.png\0`)
    gitBuffer
      .mockRejectedValueOnce(new Error('Synthetic conflict'))
      .mockResolvedValueOnce({ stdout: conflict })
    expect(await readGitBlobAtIndexPath('/repo', 'image.png')).toMatchObject({
      exists: true,
      unmerged: true,
      failed: true
    })
    gitBuffer
      .mockRejectedValueOnce(new Error('Synthetic conflict'))
      .mockResolvedValueOnce({ stdout: conflict })
      .mockResolvedValueOnce({ stdout: image })
    expect(await readUnstagedLeftBlob('/repo', 'image.png')).toMatchObject({
      content: image.toString('base64'),
      exists: true,
      failed: true
    })
    expect(gitBuffer).toHaveBeenLastCalledWith(
      ['cat-file', '--filters', '--', 'HEAD:image.png'],
      expect.any(Object)
    )
  })
})
