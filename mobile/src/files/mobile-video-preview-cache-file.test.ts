import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({
  File: vi.fn(),
  Paths: { cache: 'file:///cache' }
}))

import { File as FsFile } from 'expo-file-system'
import {
  deleteMobileVideoPreviewFile,
  mobileVideoPreviewFileName,
  writeMobileVideoPreviewFile
} from './mobile-video-preview-cache-file'

const FileMock = vi.mocked(FsFile)

beforeEach(() => {
  FileMock.mockReset()
})

describe('mobile-video-preview-cache-file', () => {
  it('names the staged file after its container so the native player picks a demuxer', () => {
    expect(mobileVideoPreviewFileName('assets/demo.mp4', 'video/mp4')).toMatch(/\.mp4$/)
    expect(mobileVideoPreviewFileName('assets/demo.mov', 'video/quicktime')).toMatch(/\.mov$/)
    expect(mobileVideoPreviewFileName('assets/demo.mp4', 'video/unknown')).toMatch(/\.mp4$/)
  })

  it('keeps one cache slot per source path and separates different paths', () => {
    const same = mobileVideoPreviewFileName('assets/demo.mp4', 'video/mp4')
    expect(mobileVideoPreviewFileName('assets/demo.mp4', 'video/mp4')).toBe(same)
    expect(mobileVideoPreviewFileName('other/demo.mp4', 'video/mp4')).not.toBe(same)
  })

  it('writes base64 bytes into the cache directory and returns the file uri', () => {
    const create = vi.fn()
    const write = vi.fn()
    FileMock.mockImplementation(function () {
      return { create, write, uri: 'file:///cache/orca-video-preview-1.mp4' } as never
    })

    expect(writeMobileVideoPreviewFile('orca-video-preview-1.mp4', 'dmlkZW8=')).toBe(
      'file:///cache/orca-video-preview-1.mp4'
    )
    expect(FileMock).toHaveBeenCalledWith('file:///cache', 'orca-video-preview-1.mp4')
    expect(create).toHaveBeenCalledWith({ overwrite: true })
    expect(write).toHaveBeenCalledWith('dmlkZW8=', { encoding: 'base64' })
  })

  it('swallows a failed cleanup so leaving the preview never throws', () => {
    FileMock.mockImplementation(function () {
      return {
        delete: () => {
          throw new Error('ENOENT')
        }
      } as never
    })

    expect(() => deleteMobileVideoPreviewFile('file:///cache/gone.mp4')).not.toThrow()
  })
})
