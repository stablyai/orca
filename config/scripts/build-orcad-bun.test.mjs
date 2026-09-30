import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { bunExecutableName, findBunExecutable } from './build-orcad-bun.mjs'

const temporaryDirs = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function archiveTree(filename) {
  const root = mkdtempSync(join(tmpdir(), 'orcad-bun-archive-'))
  temporaryDirs.push(root)
  const nested = join(root, 'bun-release')
  mkdirSync(nested)
  writeFileSync(join(nested, filename), '')
  return root
}

describe('orcad Bun archive extraction', () => {
  it('selects bun.exe for a Windows target on a non-Windows builder', () => {
    const root = archiveTree('bun.exe')
    expect(findBunExecutable(root, 'win32-x64')).toBe(join(root, 'bun-release', 'bun.exe'))
  })

  it('selects bun for a POSIX target', () => {
    const root = archiveTree('bun')
    expect(findBunExecutable(root, 'linux-x64-glibc')).toBe(join(root, 'bun-release', 'bun'))
  })

  it('derives executable names from the target rather than the builder host', () => {
    expect(bunExecutableName('win32-arm64')).toBe('bun.exe')
    expect(bunExecutableName('darwin-arm64')).toBe('bun')
  })
})
