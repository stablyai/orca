import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeOwnerOnlyFileDurable } from './owner-only-durable-file-write'

const acl = vi.hoisted(() => ({ fileRestricted: true }))

vi.mock('../../shared/secure-storage/secure-path-windows-acl', () => ({
  restrictWindowsDirectory: async () => true,
  restrictWindowsFile: async () => acl.fileRestricted
}))
vi.mock('../../shared/secure-storage/windows-security-addon', () => ({
  loadWindowsSecurity: () => ({ addon: {}, userSid: 'S-1-5-21-1' })
}))

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-owner-only-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})

afterEach(() => {
  vi.restoreAllMocks()
  acl.fileRestricted = true
  rmSync(directory, { recursive: true, force: true })
})

describe('writeOwnerOnlyFileDurable on Windows', () => {
  it('publishes nothing when the staged file cannot be restricted to its owner', async () => {
    acl.fileRestricted = false
    const target = join(directory, 'secret.json')

    await expect(writeOwnerOnlyFileDurable(target, '{"token":1}')).rejects.toThrow(
      /Could not restrict .* to its owner/
    )
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(join(directory, '.owner-only-staging'))).toEqual([])
  })
})
