import { beforeEach, describe, expect, it, vi } from 'vitest'

const existsSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:fs', () => ({ existsSync: existsSyncMock, readFileSync: readFileSyncMock }))

const { readCredentialFileProtection } = await import('./credential-file-protection')

describe('readCredentialFileProtection', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
  })

  it('reports null when the file does not exist', () => {
    existsSyncMock.mockReturnValue(false)
    expect(readCredentialFileProtection('/tokens/linear')).toBeNull()
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  // Why null and not 'plaintext': credentialFileHasContent already treats an empty
  // file as "no credential saved", so warning about one would contradict the badge.
  it('reports null for an empty file, which reads as no credential at all', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.alloc(0))
    expect(readCredentialFileProtection('/tokens/linear')).toBeNull()
  })

  it('reports plaintext for a bare token', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('lin_api_abcdef123456', 'utf8'))
    expect(readCredentialFileProtection('/tokens/linear')).toBe('plaintext')
  })

  it('reports sealed for ciphertext', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from([0x76, 0x31, 0x30, 0x00, 0x8f, 0x02, 0x1c]))
    expect(readCredentialFileProtection('/tokens/linear')).toBe('sealed')
  })

  it('reports null when the file cannot be read rather than guessing', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    expect(readCredentialFileProtection('/tokens/linear')).toBeNull()
  })
})
