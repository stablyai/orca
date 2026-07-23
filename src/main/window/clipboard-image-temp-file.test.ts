import { describe, expect, it, vi } from 'vitest'

const { fsWriteFileMock, randomUUIDMock, getSshFilesystemProviderMock } = vi.hoisted(() => ({
  fsWriteFileMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: fsWriteFileMock
  }
}))

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/local-temp')
  }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: getSshFilesystemProviderMock
}))

import {
  sanitizeAttachmentFileName,
  saveClipboardImageBufferAsTempFile
} from './clipboard-image-temp-file'

const UUID = '00000000-0000-4000-8000-000000000000'

describe('sanitizeAttachmentFileName', () => {
  it('keeps an ordinary file name unchanged', () => {
    expect(sanitizeAttachmentFileName('report.pdf')).toBe('report.pdf')
  })

  it('neutralizes path traversal names', () => {
    expect(sanitizeAttachmentFileName('../../x')).toBe('x')
  })

  it('removes path separators of both flavors', () => {
    expect(sanitizeAttachmentFileName('a/b\\c.txt')).toBe('abc.txt')
  })

  it('removes control characters', () => {
    // Escapes, not raw bytes, so this test file stays text-diffable in review.
    expect(sanitizeAttachmentFileName('a\x00b\x1fc\x7f.log')).toBe('abc.log')
  })

  it('strips leading dots so temp files cannot hide', () => {
    expect(sanitizeAttachmentFileName('...hidden.txt')).toBe('hidden.txt')
  })

  it('returns null when nothing survives sanitization', () => {
    expect(sanitizeAttachmentFileName('')).toBeNull()
    expect(sanitizeAttachmentFileName('...')).toBeNull()
    expect(sanitizeAttachmentFileName('///\\\\')).toBeNull()
    expect(sanitizeAttachmentFileName(' ')).toBeNull()
  })

  it('drops shell metacharacters so a pasted path cannot execute on Enter', () => {
    expect(sanitizeAttachmentFileName('notes;curl evil.sh -o- $(id).pdf')).toBe(
      'notescurlevil.sh-o-id.pdf'
    )
    expect(sanitizeAttachmentFileName('a`b|c&d.txt')).toBe('abcd.txt')
  })

  it('drops interior spaces so the path stays a single shell token', () => {
    expect(sanitizeAttachmentFileName('meeting notes.pdf')).toBe('meetingnotes.pdf')
  })

  it('drops Unicode line/format separators that would break the pasted path', () => {
    expect(sanitizeAttachmentFileName('a b\u202ec\u200b.txt')).toBe('abc.txt')
  })

  it('removes characters Windows filesystems reject', () => {
    expect(sanitizeAttachmentFileName('report:v2<final>?.pdf')).toBe('reportv2final.pdf')
    expect(sanitizeAttachmentFileName('a"b|c*d.txt')).toBe('abcd.txt')
  })

  it('slices attacker-sized input before per-code-point work', () => {
    // A frame-cap-sized name must not cost O(input) sanitization: only the
    // first 1024 chars are ever examined, and the result still lands ≤ 80 bytes.
    const sanitized = sanitizeAttachmentFileName(`${'x'.repeat(1_000_000)}.pdf`)
    expect(Buffer.byteLength(sanitized ?? '')).toBeLessThanOrEqual(80)
    expect(sanitized?.startsWith('x')).toBe(true)
  })

  it('caps long names at 80 bytes preserving the extension', () => {
    const sanitized = sanitizeAttachmentFileName(`${'a'.repeat(100)}.pdf`)
    expect(Buffer.byteLength(sanitized ?? '')).toBe(80)
    expect(sanitized?.endsWith('.pdf')).toBe(true)
    expect(sanitized?.startsWith('a'.repeat(76))).toBe(true)
  })

  it('caps multibyte names by byte length, not code units', () => {
    // 80 CJK chars = 240 UTF-8 bytes; must be truncated to <= 80 bytes.
    const sanitized = sanitizeAttachmentFileName(`${'历'.repeat(80)}.txt`)
    expect(Buffer.byteLength(sanitized ?? '')).toBeLessThanOrEqual(80)
    expect(sanitized?.endsWith('.txt')).toBe(true)
  })

  it('never splits a multibyte character at the byte cap', () => {
    // A trailing emoji straddling the cut must not leave a lone surrogate (U+FFFD).
    const sanitized = sanitizeAttachmentFileName(`${'a'.repeat(78)}😀😀😀.txt`)
    expect(sanitized).not.toContain('�')
    expect(Buffer.byteLength(sanitized ?? '')).toBeLessThanOrEqual(80)
  })

  it('truncates outright when the extension itself cannot fit', () => {
    const sanitized = sanitizeAttachmentFileName(`a.${'x'.repeat(120)}`)
    expect(Buffer.byteLength(sanitized ?? '')).toBe(80)
  })

  it('preserves unicode letters while dropping the interior space', () => {
    expect(sanitizeAttachmentFileName('résumé 简历.txt')).toBe('résumé简历.txt')
  })

  it('strips trailing dots that Windows drops silently', () => {
    expect(sanitizeAttachmentFileName('archive...')).toBe('archive')
  })
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('keeps the byte-identical orca-paste png name when no fileName is given', async () => {
    fsWriteFileMock.mockResolvedValue(undefined)

    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('bytes'))

    expect(savedPath).toMatch(new RegExp(`^/local-temp/orca-paste-\\d+-${UUID}\\.png$`))
  })

  it('appends the sanitized original name for named attachments', async () => {
    fsWriteFileMock.mockResolvedValue(undefined)

    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('bytes'), {
      fileName: '../notes/agenda.md'
    })

    expect(savedPath).toMatch(new RegExp(`^/local-temp/orca-file-\\d+-${UUID}-notesagenda\\.md$`))
  })

  it('falls back to the generated name with no suffix when the name sanitizes away', async () => {
    fsWriteFileMock.mockResolvedValue(undefined)

    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('bytes'), {
      fileName: '///'
    })

    expect(savedPath).toMatch(new RegExp(`^/local-temp/orca-file-\\d+-${UUID}$`))
  })

  it('uses identical naming for SSH remote writes', async () => {
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    getSshFilesystemProviderMock.mockReturnValue({
      getTempDir: async () => '/remote/tmp',
      writeFileBase64
    })

    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('bytes'), {
      connectionId: 'ssh-1',
      fileName: 'trace.log'
    })

    expect(savedPath).toMatch(new RegExp(`^/remote/tmp/orca-file-\\d+-${UUID}-trace\\.log$`))
    expect(writeFileBase64).toHaveBeenCalledWith(savedPath, Buffer.from('bytes').toString('base64'))
  })
})
