import { describe, expect, it, vi } from 'vitest'
import {
  createNativePlaybackSuppressionAdapter,
  type NativePlaybackSuppressionRunner
} from './playback-suppression-native'

describe('Native playback suppression', () => {
  it('snapshots the exact default output endpoint and its mute state', async () => {
    const run = vi.fn<NativePlaybackSuppressionRunner>(async () => ({
      stdout: JSON.stringify({
        endpointId: 'speaker-uid',
        endpointTarget: '42',
        muted: false
      }),
      stderr: ''
    }))
    const adapter = createNativePlaybackSuppressionAdapter({
      backend: 'coreaudio',
      executablePath: '/native/orca-playback-suppression',
      run
    })

    await expect(adapter.snapshot()).resolves.toEqual({
      backend: 'coreaudio',
      endpointId: 'speaker-uid',
      endpointTarget: '42',
      muted: false
    })
    expect(run).toHaveBeenCalledWith('/native/orca-playback-suppression', ['snapshot'], undefined)
  })

  it('restores the captured endpoint instead of whichever endpoint is now default', async () => {
    const run = vi.fn<NativePlaybackSuppressionRunner>(async () => ({ stdout: '', stderr: '' }))
    const adapter = createNativePlaybackSuppressionAdapter({
      backend: 'windows-core-audio',
      executablePath: 'C:\\Orca\\orca-playback-suppression.exe',
      run
    })

    await adapter.setMuted(false, undefined, {
      backend: 'windows-core-audio',
      endpointId: '{speaker-guid}',
      endpointTarget: '{speaker-guid}',
      muted: false
    })

    expect(run).toHaveBeenCalledWith(
      'C:\\Orca\\orca-playback-suppression.exe',
      [
        'set-muted',
        '--endpoint-id',
        '{speaker-guid}',
        '--endpoint-target',
        '{speaker-guid}',
        'false'
      ],
      undefined
    )
  })

  it('reports unavailable when the helper output cannot prove a restorable endpoint', async () => {
    const run = vi.fn<NativePlaybackSuppressionRunner>(async () => ({
      stdout: JSON.stringify({ endpointId: 'speaker-uid', muted: false }),
      stderr: ''
    }))
    const adapter = createNativePlaybackSuppressionAdapter({
      backend: 'coreaudio',
      executablePath: '/native/orca-playback-suppression',
      run
    })

    await expect(adapter.getCapability()).resolves.toBe(false)
    await expect(adapter.snapshot()).rejects.toThrow('restorable output endpoint')
  })

  it('refuses to mutate without a matching native snapshot', async () => {
    const run = vi.fn<NativePlaybackSuppressionRunner>()
    const adapter = createNativePlaybackSuppressionAdapter({
      backend: 'coreaudio',
      executablePath: '/native/orca-playback-suppression',
      run
    })

    await expect(adapter.setMuted(true)).rejects.toThrow('captured output endpoint')
    expect(run).not.toHaveBeenCalled()
  })
})
