import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { peImage } from './windows-pe-image-fixture.mjs'

const { verifyPackagedWindowsAgentHook } = createRequire(import.meta.url)(
  './verify-packaged-windows-agent-hook.cjs'
)

const roots = []

function resourcesWith(image) {
  const resourcesDir = mkdtempSync(join(tmpdir(), 'orca-agent-hook-package-'))
  roots.push(resourcesDir)
  if (image) {
    mkdirSync(join(resourcesDir, 'bin'))
    writeFileSync(join(resourcesDir, 'bin', 'orca-agent-hook.exe'), image)
  }
  return resourcesDir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('verifyPackagedWindowsAgentHook', () => {
  it('accepts a hook built for the packaged slice', () => {
    expect(() =>
      verifyPackagedWindowsAgentHook(resourcesWith(peImage({ arch: 'x64' })), 1)
    ).not.toThrow()
    expect(() =>
      verifyPackagedWindowsAgentHook(resourcesWith(peImage({ arch: 'arm64' })), 3)
    ).not.toThrow()
  })

  it('refuses a missing hook instead of shipping the .cmd fallback silently', () => {
    expect(() => verifyPackagedWindowsAgentHook(resourcesWith(null), 1)).toThrow(
      'Missing packaged agent hook'
    )
  })

  it('refuses a host-arch hook in a cross-built slice', () => {
    expect(() =>
      verifyPackagedWindowsAgentHook(resourcesWith(peImage({ arch: 'x64' })), 3)
    ).toThrow('machine 0x8664')
    expect(() => verifyPackagedWindowsAgentHook(resourcesWith(Buffer.from('not a PE')), 1)).toThrow(
      'not a PE image'
    )
  })
})
