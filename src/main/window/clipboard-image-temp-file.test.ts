import { basename, dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeFileMock, mkdirMock, getPathMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  getPathMock: vi.fn((name: string) =>
    name === 'temp' ? '/os/temp' : '/Users/me/Library/Application Support/orca'
  )
}))

vi.mock('node:fs/promises', () => ({ default: { writeFile: writeFileMock, mkdir: mkdirMock } }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
}))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('keeps a terminal, editor or phone paste in OS temp, as before', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(getPathMock).toHaveBeenCalledWith('temp')
    expect(getPathMock).not.toHaveBeenCalledWith('userData')
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(dirname(savedPath)).toBe(join('/os/temp'))
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
  })

  it('writes a terminal-backed composer paste into the never-swept paste folder', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]), {
      forNativeChatDraft: true
    })

    expect(mkdirMock).toHaveBeenCalledWith(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes'),
      { recursive: true }
    )
    expect(dirname(savedPath)).toBe(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes')
    )
    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
  })

  it('preserves the original sanitized file name and extension when provided', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('hello'), {
      fileName: '../dir/柴静-看见.txt'
    })

    expect(dirname(savedPath)).toBe(join('/os/temp'))
    expect(savedPath).toMatch(/orca-paste-\d+-uuid-1-柴静-看见\.txt$/)
  })

  it('keeps supplied extensionless file names extensionless instead of appending .png', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('FROM node:22'), {
      fileName: '../dir/Dockerfile'
    })

    expect(basename(savedPath)).toMatch(/^orca-paste-\d+-uuid-1-Dockerfile$/)
  })

  it('bounds the complete generated file name within 255 UTF-8 bytes for multi-byte names', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('hello'), {
      fileName: `${'中'.repeat(90)}.txt`
    })

    const generatedName = basename(savedPath)
    expect(generatedName).toMatch(/^orca-paste-\d+-uuid-1-中+\.txt$/)
    expect(Buffer.byteLength(generatedName, 'utf8')).toBeLessThanOrEqual(255)
  })
})
