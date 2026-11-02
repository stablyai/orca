import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const created = vi.hoisted((): string[] => [])
vi.mock('../shared/secure-path-windows-acl', () => ({
  writeRestrictedWindowsFile: (path: string, contents: string | Buffer) => {
    created.push(path)
    writeFileSync(path, contents)
    return true
  }
}))

describe('writeCredentialFileAtomic on Windows', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('stages the replacement as a born-restricted file, so the owner-only ACL survives', async () => {
    const { writeCredentialFileAtomic } = await import('./integration-credential-file')
    const dir = mkdtempSync(join(tmpdir(), 'credential-acl-'))
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const target = join(dir, 'linear-token.enc')
      expect(writeCredentialFileAtomic(target, Buffer.from([0, 1, 2, 3]))).toBe(true)
      expect(created).toHaveLength(1)
      expect(created[0]).toMatch(/linear-token\.enc\..+\.tmp$/)
      expect(readFileSync(target)).toEqual(Buffer.from([0, 1, 2, 3]))
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
