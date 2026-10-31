import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  stageWslNodeRuntimeArchive,
  verifyPackagedWslNodeRuntime,
  windowsInstallerArch,
  wslNodeRuntimeExtraResource
} = require('./packaged-wsl-node-runtime.cjs')
const { NODE_RUNTIME_ASSETS } = require('../../src/shared/node-runtime-pin.ts')

const X64 = 1
const ARM64 = 3
const originals = {
  'linux-x64-glibc': { ...NODE_RUNTIME_ASSETS['linux-x64-glibc'] },
  'linux-arm64-glibc': { ...NODE_RUNTIME_ASSETS['linux-arm64-glibc'] }
}
const roots = []

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'packaged-wsl-node-'))
  roots.push(root)
  return root
}

function pinBytes(target, bytes) {
  NODE_RUNTIME_ASSETS[target].archiveSha256 = createHash('sha256').update(bytes).digest('hex')
}

afterEach(() => {
  for (const [target, asset] of Object.entries(originals)) {
    Object.assign(NODE_RUNTIME_ASSETS[target], asset)
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('the WSL Node archive a Windows installer bundles', () => {
  it('matches the installer architecture and ships under the runtime-bundle directory', () => {
    expect(windowsInstallerArch(X64)).toBe('x64')
    expect(windowsInstallerArch(ARM64)).toBe('arm64')
    expect(() => windowsInstallerArch(0)).toThrow('no WSL Node archive')
    expect(wslNodeRuntimeExtraResource).toEqual({
      from: 'out/wsl-node-runtime/${arch}',
      to: 'node-runtime-archives'
    })
  })

  it('stages the pinned archive for the slice it packages', async () => {
    const projectDir = scratch()
    pinBytes('linux-arm64-glibc', 'arm64 node')
    const fetchFile = vi.fn(async ({ destination }) => {
      mkdirSync(join(destination, '..'), { recursive: true })
      writeFileSync(destination, 'arm64 node')
      return destination
    })
    const staged = await stageWslNodeRuntimeArchive(ARM64, { projectDir, fetchFile })
    expect(staged).toBe(
      join(projectDir, 'out/wsl-node-runtime/arm64', originals['linux-arm64-glibc'].archive)
    )
    expect(fetchFile.mock.calls[0][0].url).toContain(originals['linux-arm64-glibc'].archive)
  })

  it('fails packaging when the archive cannot be fetched or does not match the pin', async () => {
    const projectDir = scratch()
    pinBytes('linux-x64-glibc', 'x64 node')
    await expect(
      stageWslNodeRuntimeArchive(X64, {
        projectDir,
        fetchFile: async () => {
          throw new Error('getaddrinfo ENOTFOUND nodejs.org')
        }
      })
    ).rejects.toThrow('ENOTFOUND')
    await expect(
      stageWslNodeRuntimeArchive(X64, {
        projectDir,
        fetchFile: async ({ destination }) => {
          mkdirSync(join(destination, '..'), { recursive: true })
          writeFileSync(destination, 'tampered')
        }
      })
    ).rejects.toThrow('does not match the Node runtime pin')
  })

  it('refuses a packaged app whose resources lack the verified archive', () => {
    const resourcesDir = scratch()
    pinBytes('linux-x64-glibc', 'x64 node')
    expect(() => verifyPackagedWslNodeRuntime(resourcesDir, X64)).toThrow(
      'missing the pinned WSL Node archive'
    )
    mkdirSync(join(resourcesDir, 'node-runtime-archives'))
    writeFileSync(
      join(resourcesDir, 'node-runtime-archives', originals['linux-x64-glibc'].archive),
      'x64 node'
    )
    expect(() => verifyPackagedWslNodeRuntime(resourcesDir, X64)).not.toThrow()
  })
})
