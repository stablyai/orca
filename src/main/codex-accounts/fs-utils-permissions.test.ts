import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from './fs-utils'
import { grantDirAcl } from '../win32-utils'

const fsMock = vi.hoisted(() => ({ writeFileSync: vi.fn(), linkSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync)
  fsMock.linkSync.mockImplementation(actual.linkSync)
  return { ...actual, writeFileSync: fsMock.writeFileSync, linkSync: fsMock.linkSync }
})
vi.mock('../win32-utils', () => ({
  grantDirAcl: vi.fn(),
  isPermissionError: (error: NodeJS.ErrnoException) => error.code === 'EACCES'
}))
const originalPlatform = process.platform
let directory: string
function denied(): never {
  throw Object.assign(new Error('denied'), { code: 'EACCES' })
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-fs-permissions-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(grantDirAcl).mockClear()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  rmSync(directory, { recursive: true, force: true })
})

describe('atomic writes without permission repair', () => {
  it.each(['unguarded', 'guarded'])('does not grant an ACL after a %s write failure', (kind) => {
    const target = join(directory, 'config')
    fsMock.writeFileSync.mockImplementationOnce(denied)
    expect(() =>
      kind === 'unguarded'
        ? writeFileAtomically(target, 'next', { repairPermissions: false })
        : writeFileAtomicallyIfUnchanged(target, null, 'next', { repairPermissions: false })
    ).toThrow('denied')
    expect(grantDirAcl).not.toHaveBeenCalled()
  })
  it('does not grant an ACL during guarded hard-link publication', () => {
    const target = join(directory, 'config')
    writeFileSync(target, 'original')
    fsMock.linkSync.mockImplementationOnce(denied)
    expect(() =>
      writeFileAtomicallyIfUnchanged(target, 'original', 'next', { repairPermissions: false })
    ).toThrow('denied')
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(grantDirAcl).not.toHaveBeenCalled()
  })
  it('retains permission repair for callers that use the existing default', () => {
    const target = join(directory, 'config')
    fsMock.writeFileSync.mockImplementationOnce(denied)
    writeFileAtomically(target, 'next')
    expect(grantDirAcl).toHaveBeenCalledWith(directory)
    expect(readFileSync(target, 'utf8')).toBe('next')
  })
})
