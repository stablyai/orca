import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareDevComputerHelper } from './dev-computer-helper-prepare.mjs'

const tempDirs = []

function createRepoRoot({ withHelper = false } = {}) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'orca-computer-helper-'))
  tempDirs.push(repoRoot)
  if (withHelper) {
    mkdirSync(
      path.join(
        repoRoot,
        'native',
        'computer-use-macos',
        '.build',
        'release',
        'Orca Computer Use.app'
      ),
      { recursive: true }
    )
  }
  return repoRoot
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('prepareDevComputerHelper', () => {
  it('prints one actionable message and continues when the helper is missing', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()

    prepareDevComputerHelper({
      env: {},
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot: createRepoRoot(),
      runBuild,
      writeMessage
    })

    expect(writeMessage).toHaveBeenCalledOnce()
    expect(writeMessage).toHaveBeenCalledWith(
      expect.stringContaining('pnpm run build:computer-macos')
    )
    expect(writeMessage).toHaveBeenCalledWith(
      expect.stringContaining('ORCA_DEV_COMPUTER_PREPARE=1')
    )
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('builds a missing helper only when explicitly requested', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()

    prepareDevComputerHelper({
      env: { ORCA_DEV_COMPUTER_PREPARE: '1' },
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot: createRepoRoot(),
      runBuild,
      writeMessage
    })

    expect(writeMessage).toHaveBeenCalledWith('[orca-dev] Building Computer Use helper...')
    expect(runBuild).toHaveBeenCalledOnce()
  })

  it('does no work when the helper already exists or the platform is not macOS', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()

    prepareDevComputerHelper({
      env: { ORCA_DEV_COMPUTER_PREPARE: '1' },
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot: createRepoRoot({ withHelper: true }),
      runBuild,
      writeMessage
    })
    prepareDevComputerHelper({
      env: {},
      isHelpOrVersion: false,
      platform: 'linux',
      repoRoot: createRepoRoot(),
      runBuild,
      writeMessage
    })

    expect(writeMessage).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })
})
