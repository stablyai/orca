import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { orcadArtifactFilenames } from '../../src/shared/orcad-artifacts.ts'
import {
  computeOrcadArtifactVersion,
  verifyOrcadArtifactTarget
} from './verify-orcad-bun-matrix.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(target = '') {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-matrix-version-'))
  temporaryDirectories.push(dir)
  for (const filename of orcadArtifactFilenames(target)) {
    const path = join(dir, filename)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, filename)
  }
  writeFileSync(join(dir, 'agent-browser-test'), 'browser')
  if (target) {
    writeFileSync(join(dir, '.build-target'), target)
  }
  return dir
}

describe('orcad Bun matrix verification', () => {
  it('hashes the Windows executable layout distinctly from an extensionless slot', async () => {
    const dir = fixture('win32-x64')
    const hash = createHash('sha256').update('bun-runtime.exe\0')
    for (const filename of orcadArtifactFilenames('win32-x64')) {
      hash.update(filename === '.build-target' ? 'win32-x64' : filename)
    }
    hash.update('browser')
    await expect(computeOrcadArtifactVersion(dir, 'agent-browser-test')).resolves.toBe(
      `0.1.0+${hash.digest('hex').slice(0, 12)}`
    )
  })
  it('recomputes the build content version in the declared artifact order', async () => {
    const dir = fixture()
    const hash = createHash('sha256')
    for (const filename of orcadArtifactFilenames()) {
      hash.update(filename)
    }
    hash.update('browser')

    await expect(computeOrcadArtifactVersion(dir, 'agent-browser-test')).resolves.toBe(
      `0.1.0+${hash.digest('hex').slice(0, 12)}`
    )
  })

  it('rejects a target marker inherited from a different template slot', () => {
    const dir = fixture()
    writeFileSync(join(dir, '.build-target'), 'linux-x64-glibc\n')

    expect(() => verifyOrcadArtifactTarget(dir, 'linux-x64-musl')).toThrow(
      'linux-x64-musl artifact records build target linux-x64-glibc'
    )
  })
})
