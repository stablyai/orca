import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { peImage } from '../../native-build/windows/windows-pe-image-fixture.mjs'
import { withInvalidSecurityCandidate } from './benchmark-windows-security-reuse.mjs'

const directories = []
afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
function fixture(arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'orca-security-qualification-'))
  directories.push(root)
  const candidate = join(root, 'native/windows-security/build/Release/orca_windows_security.node')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(candidate, peImage({ arch }))
  return { root, candidate }
}

it.each(['success', 'rejection'])(
  'restores exact candidate bytes and permissions after %s',
  async (outcome) => {
    const f = fixture()
    const original = readFileSync(f.candidate)
    const before = statSync(f.candidate)
    const action = async () => {
      expect(readFileSync(f.candidate)).not.toEqual(original)
      if (outcome === 'rejection') {
        throw new Error('failed sample')
      }
      return 'proof'
    }
    const operation = withInvalidSecurityCandidate(f.candidate, f.root, digest(original), action)
    if (outcome === 'rejection') {
      await expect(operation).rejects.toThrow('failed sample')
    } else {
      expect(await operation).toBe('proof')
    }
    expect(readFileSync(f.candidate)).toEqual(original)
    expect(statSync(f.candidate).mode).toBe(before.mode)
    expect(statSync(f.candidate).mtimeMs).toBeCloseTo(before.mtimeMs, 0)
  }
)

it('refuses a changed candidate, symlink and preexisting backup before invalidating', async () => {
  const f = fixture()
  const bytes = readFileSync(f.candidate)
  const action = vi.fn()
  await expect(
    withInvalidSecurityCandidate(f.candidate, f.root, 'wrong hash', action)
  ).rejects.toThrow()
  writeFileSync(join(f.root, 'prepared-security-backup.node'), 'occupied')
  await expect(
    withInvalidSecurityCandidate(f.candidate, f.root, digest(bytes), action)
  ).rejects.toThrow()
  const link = join(f.root, 'link.node')
  symlinkSync(dirname(f.candidate), link, 'junction')
  await expect(withInvalidSecurityCandidate(link, f.root, digest(bytes), action)).rejects.toThrow(
    'regular file'
  )
  expect(readFileSync(f.candidate)).toEqual(bytes)
  expect(action).not.toHaveBeenCalled()
})
