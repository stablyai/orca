import { describe, expect, it, vi } from 'vitest'
import { createPlaybackSuppressionAdapter } from './playback-suppression-platform'
import type { NativePlaybackSuppressionRunner } from './playback-suppression-native'

const response = {
  stdout: JSON.stringify({ endpointId: 'device', endpointTarget: '7', muted: false }),
  stderr: ''
}

describe('Platform playback suppression', () => {
  it.each([
    [
      'darwin' as const,
      '/Applications/Orca.app/Contents/Resources/playback-suppression/orca-playback-suppression',
      'coreaudio'
    ],
    [
      'win32' as const,
      'C:\\Orca\\resources\\playback-suppression\\orca-playback-suppression.exe',
      'windows-core-audio'
    ]
  ])('uses the packaged native helper on %s', async (platform, expectedPath, backend) => {
    const runNative = vi.fn<NativePlaybackSuppressionRunner>(async () => response)
    const adapter = createPlaybackSuppressionAdapter(platform, {
      isPackaged: true,
      resourcesPath:
        platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources' : 'C:\\Orca\\resources',
      runNative
    })

    await expect(adapter.snapshot()).resolves.toMatchObject({ backend })
    expect(runNative).toHaveBeenCalledWith(expectedPath, ['snapshot'], undefined)
  })

  it('resolves a development helper from the checkout', async () => {
    const runNative = vi.fn<NativePlaybackSuppressionRunner>(async () => response)
    const adapter = createPlaybackSuppressionAdapter('darwin', {
      isPackaged: false,
      resourcesPath: '',
      projectRoot: '/checkout',
      runNative
    })

    await adapter.snapshot()
    expect(runNative).toHaveBeenCalledWith(
      '/checkout/native/playback-suppression-macos/.build/release/orca-playback-suppression',
      ['snapshot'],
      undefined
    )
  })

  it('keeps unsupported platforms unavailable', async () => {
    const adapter = createPlaybackSuppressionAdapter('freebsd', {
      isPackaged: false,
      resourcesPath: ''
    })

    await expect(adapter.getCapability()).resolves.toBe(false)
  })
})
