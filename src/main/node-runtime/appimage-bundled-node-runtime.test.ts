import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import { findAppImageNodeRuntime } from './appimage-bundled-node-runtime'

let resources = ''

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), 'orca-appimage-node-'))
})

afterEach(() => {
  rmSync(resources, { recursive: true, force: true })
})

function bundle(): string {
  const path = join(resources, 'node-runtime', 'bin', 'node')
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  return path
}

describe('findAppImageNodeRuntime', () => {
  it('names the pinned glibc Node a Linux package carries for its CPU', () => {
    const path = bundle()
    expect(findAppImageNodeRuntime(resources, 'arm64', 'linux')).toEqual({
      path,
      target: 'linux-arm64-glibc',
      executableSha256: NODE_RUNTIME_ASSETS['linux-arm64-glibc'].executableSha256
    })
  })

  it('finds nothing in a package without one, or off Linux', () => {
    expect(findAppImageNodeRuntime(resources, 'x64', 'linux')).toBeNull()
    bundle()
    expect(findAppImageNodeRuntime(resources, 'x64', 'darwin')).toBeNull()
    expect(findAppImageNodeRuntime(resources, 'ia32', 'linux')).toBeNull()
    expect(findAppImageNodeRuntime(undefined, 'x64', 'linux')).toBeNull()
  })
})
