import { describe, expect, it, vi } from 'vitest'
import { buildAndInstallHostedIosSimulatorApp } from '../../scripts/hosted-ios-simulator-app-build.mjs'

describe('hosted iOS simulator app build', () => {
  it('removes persisted app state before installing the exact build', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    const appPath = await buildAndInstallHostedIosSimulatorApp({
      deviceUdid: 'simulator-1',
      worktree: '/worktree',
      runCommand
    })

    expect(runCommand).toHaveBeenNthCalledWith(2, 'xcrun', [
      'simctl',
      'uninstall',
      'simulator-1',
      'com.stably.orca.mobile'
    ])
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      'xcrun',
      ['simctl', 'install', 'simulator-1', appPath],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    expect(runCommand).toHaveBeenNthCalledWith(4, 'xcrun', [
      'simctl',
      'spawn',
      'simulator-1',
      'defaults',
      'write',
      'com.stably.orca.mobile',
      'EXDevMenuShowFloatingActionButton',
      '-bool',
      'false'
    ])
  })

  it('continues when no prior app is installed', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('not installed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      buildAndInstallHostedIosSimulatorApp({
        deviceUdid: 'simulator-1',
        worktree: '/worktree',
        runCommand
      })
    ).resolves.toContain('Orca.app')
  })
})
