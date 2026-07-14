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
  openStoredAttachment,
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

  it('keeps an existing extension untouched when it already matches the mime allowlist', () => {
    expect(sanitizeAttachmentFileName('a.pdf', 'application/pdf')).toBe('a.pdf')
  })

  it('falls back to .bin for an unmapped mime type', () => {
    expect(sanitizeAttachmentFileName('mystery', 'application/x-unknown')).toBe('mystery.bin')
  })

  // Security: web-chat fileName/mime metadata is untrusted. A hostile attachment
  // could claim fileName='invoice.exe' with mime='image/png' to get an executable
  // opened via shell.openPath. The output extension must always come from the
  // mime allowlist, never from the fileName's own extension.
  it('never trusts the fileName extension — derives it from the mime allowlist instead', () => {
    expect(sanitizeAttachmentFileName('invoice.exe', 'image/png')).toBe('invoice.png')
  })

  it('does not produce a double dot when the fileName ends with a bare dot', () => {
    expect(sanitizeAttachmentFileName('file.', 'image/png')).toBe('file.png')
  })

  it('produces a mime-derived extension for a traversal path with a spoofed extension', () => {
    const result = sanitizeAttachmentFileName('../../etc/passwd.exe', 'image/png')
    expect(result.endsWith('.png')).toBe(true)
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
    expect(result).not.toContain('..')
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

describe('openStoredAttachment', () => {
  const tempDirs: string[] = []

  function makeTmpDir(): string {
    const tmpDir = join(
      mkdtempSync(join(tmpdir(), 'chat-import-attachment-open-test-')),
      'attachments'
    )
    tempDirs.push(tmpDir)
    return tmpDir
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  // shell.openPath never rejects — it resolves an error message string on
  // failure and '' on success. The handler must inspect that string.
  it('returns ok:true when openPath resolves an empty string', async () => {
    const bytes = Buffer.from('hello world')
    const result = await openStoredAttachment(
      { readBlob: () => bytes, openPath: vi.fn().mockResolvedValue(''), tmpDir: makeTmpDir() },
      { hash: 'deadbeef', fileName: 'shot.png', mime: 'image/png' }
    )
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:false with the OS error message when openPath resolves a non-empty string', async () => {
    const bytes = Buffer.from('hello world')
    const result = await openStoredAttachment(
      { readBlob: () => bytes, openPath: vi.fn().mockResolvedValue('boom'), tmpDir: makeTmpDir() },
      { hash: 'deadbeef', fileName: 'shot.png', mime: 'image/png' }
    )
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('returns ok:false when the blob is missing', async () => {
    const openPathMock = vi.fn()
    const result = await openStoredAttachment(
      { readBlob: () => null, openPath: openPathMock, tmpDir: makeTmpDir() },
      { hash: 'missing', fileName: 'shot.png', mime: 'image/png' }
    )
    expect(result.ok).toBe(false)
    expect(openPathMock).not.toHaveBeenCalled()
  })

  it('opens a mime-derived extension, never the untrusted fileName extension', async () => {
    const openPathMock = vi.fn().mockResolvedValue('')
    const result = await openStoredAttachment(
      {
        readBlob: () => Buffer.from('fake exe bytes'),
        openPath: openPathMock,
        tmpDir: makeTmpDir()
      },
      { hash: 'deadbeef', fileName: 'x.exe', mime: 'image/png' }
    )
    expect(result).toEqual({ ok: true })
    const openedPath = openPathMock.mock.calls[0][0] as string
    expect(openedPath.endsWith('.png')).toBe(true)
    expect(openedPath.endsWith('.exe')).toBe(false)
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
