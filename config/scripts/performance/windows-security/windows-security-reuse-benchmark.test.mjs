import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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

it('restores exact candidate bytes and permissions after a rejected sample', async () => {
  const f = fixture()
  const original = readFileSync(f.candidate)
  const before = statSync(f.candidate)
  const action = async () => {
    expect(readFileSync(f.candidate)).not.toEqual(original)
    throw new Error('failed sample')
  }
  const operation = withInvalidSecurityCandidate(f.candidate, f.root, digest(original), action)
  await expect(operation).rejects.toThrow('failed sample')
  expect(readFileSync(f.candidate)).toEqual(original)
  expect(statSync(f.candidate).mode).toBe(before.mode)
  expect(statSync(f.candidate).mtimeMs).toBeCloseTo(before.mtimeMs, 0)
})
