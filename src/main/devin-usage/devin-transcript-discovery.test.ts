import { describe, expect, it, vi } from 'vitest'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-error'

const { wslGatedReaddir } = vi.hoisted(() => ({ wslGatedReaddir: vi.fn() }))

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir,
  wslGatedStat: vi.fn()
}))

import { listDevinTranscriptFiles } from './devin-transcript-discovery'

describe('listDevinTranscriptFiles', () => {
  it('returns an empty list only when the transcripts dir is missing', async () => {
    wslGatedReaddir.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    await expect(listDevinTranscriptFiles()).resolves.toEqual([])

    wslGatedReaddir.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTDIR' }))
    await expect(listDevinTranscriptFiles()).resolves.toEqual([])
  })

  it('propagates transient filesystem failures so cached usage survives', async () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    wslGatedReaddir.mockRejectedValue(eacces)
    await expect(listDevinTranscriptFiles()).rejects.toBe(eacces)

    const eio = Object.assign(new Error('io'), { code: 'EIO' })
    wslGatedReaddir.mockRejectedValue(eio)
    await expect(listDevinTranscriptFiles()).rejects.toBe(eio)
  })

  it('propagates a WSL refusal instead of swallowing it as empty', async () => {
    const refusal = new WslTranscriptFsError('timeout', 'slow share')
    wslGatedReaddir.mockRejectedValue(refusal)

    await expect(listDevinTranscriptFiles()).rejects.toBe(refusal)
  })
})
