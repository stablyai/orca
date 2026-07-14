import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { handleMock, openPathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  openPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: handleMock },
  shell: { openPath: openPathMock }
}))

import {
  registerChatImportAttachmentHandlers,
  sanitizeAttachmentFileName,
  writeAttachmentTemp
} from './chat-import-attachment'

describe('sanitizeAttachmentFileName', () => {
  it('strips directory traversal down to a bare basename', () => {
    const result = sanitizeAttachmentFileName('../../etc/passwd', 'image/png')
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
    expect(result).not.toContain('..')
  })

  it('strips Windows-style traversal even when running on a posix host', () => {
    const result = sanitizeAttachmentFileName('..\\..\\etc\\passwd', 'image/png')
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
    expect(result).not.toContain('..')
  })

  it('appends a mime-derived extension when the name has none', () => {
    expect(sanitizeAttachmentFileName('shot', 'image/png')).toBe('shot.png')
  })

  it('keeps an existing extension untouched', () => {
    expect(sanitizeAttachmentFileName('a.pdf', 'application/pdf')).toBe('a.pdf')
  })

  it('falls back to .bin for an unmapped mime type', () => {
    expect(sanitizeAttachmentFileName('mystery', 'application/x-unknown')).toBe('mystery.bin')
  })
})

describe('writeAttachmentTemp', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('writes the blob bytes to a sanitized path under tmpDir and returns it', () => {
    const tmpDir = join(mkdtempSync(join(tmpdir(), 'chat-import-attachment-test-')), 'attachments')
    tempDirs.push(tmpDir)
    const bytes = Buffer.from('hello world')
    const readBlobFn = vi.fn(() => bytes)

    const path = writeAttachmentTemp(readBlobFn, tmpDir, {
      hash: 'deadbeef',
      fileName: '../../etc/passwd',
      mime: 'image/png'
    })

    expect(readBlobFn).toHaveBeenCalledWith('deadbeef')
    expect(path.startsWith(tmpDir)).toBe(true)
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('throws a clear error when the blob is missing', () => {
    const tmpDir = join(mkdtempSync(join(tmpdir(), 'chat-import-attachment-test-')), 'attachments')
    tempDirs.push(tmpDir)
    const readBlobFn = vi.fn(() => null)

    expect(() =>
      writeAttachmentTemp(readBlobFn, tmpDir, {
        hash: 'missing',
        fileName: 'shot.png',
        mime: 'image/png'
      })
    ).toThrow()
  })
})

describe('registerChatImportAttachmentHandlers', () => {
  afterEach(() => {
    handleMock.mockReset()
    openPathMock.mockReset()
  })

  it('registers the chatImportAttachment:open channel', () => {
    registerChatImportAttachmentHandlers()
    expect(handleMock).toHaveBeenCalledWith('chatImportAttachment:open', expect.any(Function))
  })
})
