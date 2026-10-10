import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  GHOSTTY_TERMINAL_ADDON,
  assertGhosttyTerminalAddonBuilt
} = require('./verify-packaged-ghostty-terminal-addon.cjs')

const roots = []

async function projectRoot(withAddon) {
  const root = await mkdtemp(join(tmpdir(), 'orca-ghostty-addon-'))
  roots.push(root)
  if (withAddon) {
    await mkdir(dirname(join(root, GHOSTTY_TERMINAL_ADDON)), { recursive: true })
    await writeFile(join(root, GHOSTTY_TERMINAL_ADDON), '')
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('assertGhosttyTerminalAddonBuilt', () => {
  it('fails a macOS release packaged without the addon', async () => {
    const projectDir = await projectRoot(false)
    expect(() => assertGhosttyTerminalAddonBuilt('darwin', { required: true, projectDir })).toThrow(
      'build:ghostty-terminal-macos'
    )
  })

  it('passes a macOS release with the addon built', async () => {
    const projectDir = await projectRoot(true)
    expect(() =>
      assertGhosttyTerminalAddonBuilt('darwin', { required: true, projectDir })
    ).not.toThrow()
  })

  it('lets local macOS builds and other platforms package without it', async () => {
    const projectDir = await projectRoot(false)
    expect(() =>
      assertGhosttyTerminalAddonBuilt('darwin', { required: false, projectDir })
    ).not.toThrow()
    expect(() =>
      assertGhosttyTerminalAddonBuilt('linux', { required: true, projectDir })
    ).not.toThrow()
  })
})
