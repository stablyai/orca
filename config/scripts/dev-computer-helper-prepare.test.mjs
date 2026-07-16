import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareDevComputerHelper } from './dev-computer-helper-prepare.mjs'

const tempDirs = []

function createRepoRoot({ withHelper = false } = {}) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'orca-computer-helper-'))
  tempDirs.push(repoRoot)
  if (withHelper) {
    const executablePath = path.join(
      repoRoot,
      'native',
      'computer-use-macos',
      '.build',
      'release',
      'Orca Computer Use.app',
      'Contents',
      'MacOS',
      'orca-computer-use-macos'
    )
    mkdirSync(path.dirname(executablePath), { recursive: true })
    writeFileSync(executablePath, '')
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

  it('builds a missing or incomplete worktree helper only when explicitly requested', () => {
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

  it('does not accept an app bundle without its helper executable', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()
    const repoRoot = createRepoRoot()
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

    prepareDevComputerHelper({
      env: { ORCA_DEV_COMPUTER_PREPARE: '1' },
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot,
      runBuild,
      writeMessage
    })

    expect(runBuild).toHaveBeenCalledOnce()
  })

  it('honors a valid helper override', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()
    const overridePath = path.join(createRepoRoot(), 'Override Computer Use.app')
    const executablePath = path.join(overridePath, 'Contents', 'MacOS', 'orca-computer-use-macos')
    mkdirSync(path.dirname(executablePath), { recursive: true })
    writeFileSync(executablePath, '')

    prepareDevComputerHelper({
      env: { ORCA_COMPUTER_MACOS_HELPER_APP_PATH: overridePath },
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot: createRepoRoot(),
      runBuild,
      writeMessage
    })

    expect(writeMessage).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('warns instead of building when an existing helper override is incomplete', () => {
    const writeMessage = vi.fn()
    const runBuild = vi.fn()
    const overridePath = path.join(createRepoRoot(), 'Incomplete Computer Use.app')
    mkdirSync(overridePath, { recursive: true })

    prepareDevComputerHelper({
      env: {
        ORCA_COMPUTER_MACOS_HELPER_APP_PATH: overridePath,
        ORCA_DEV_COMPUTER_PREPARE: '1'
      },
      isHelpOrVersion: false,
      platform: 'darwin',
      repoRoot: createRepoRoot(),
      runBuild,
      writeMessage
    })

    expect(writeMessage).toHaveBeenCalledWith(
      expect.stringContaining('Fix or unset ORCA_COMPUTER_MACOS_HELPER_APP_PATH')
    )
    expect(runBuild).not.toHaveBeenCalled()
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
