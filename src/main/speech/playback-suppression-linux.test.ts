import { describe, expect, it, vi } from 'vitest'
import {
  createLinuxPlaybackSuppressionAdapter,
  type PlaybackSuppressionCommandRunner
} from './playback-suppression-linux'

describe('Linux playback suppression', () => {
  it('reads and changes the default PipeWire sink with wpctl', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl' && args[0] === 'get-volume') {
        return { stdout: 'Volume: 0.58\n', stderr: '' }
      }
      if (command === 'wpctl' && args[0] === 'inspect') {
        return {
          stdout:
            'id 118, type PipeWire:Interface:Node\n  * node.name = "bluez_output.speaker_1"\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })
    const adapter = createLinuxPlaybackSuppressionAdapter(run)

    await expect(adapter.snapshot()).resolves.toEqual({
      backend: 'wpctl',
      endpointId: 'bluez_output.speaker_1',
      endpointTarget: '118',
      muted: false
    })
    await adapter.setMuted(true)
    await adapter.setMuted(false)

    expect(run).toHaveBeenNthCalledWith(3, 'wpctl', ['set-mute', '118', '1'], undefined)
    expect(run).toHaveBeenNthCalledWith(4, 'wpctl', ['set-mute', '118', '0'], undefined)
  })

  it('preserves a muted wpctl snapshot', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async () => ({
      stdout: 'Volume: 0.58 [MUTED]\n',
      stderr: ''
    }))

    await expect(createLinuxPlaybackSuppressionAdapter(run).snapshot()).resolves.toEqual({
      backend: 'wpctl',
      muted: true
    })
  })

  it('falls back from wpctl to pactl and then uses that backend', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl') {
        throw new Error('ENOENT')
      }
      if (command === 'pactl' && args[0] === 'get-sink-mute') {
        return { stdout: 'Mute: no\n', stderr: '' }
      }
      if (command === 'pactl' && args[0] === 'get-default-sink') {
        return { stdout: 'alsa_output.speaker_1\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const adapter = createLinuxPlaybackSuppressionAdapter(run)

    await expect(adapter.getCapability()).resolves.toEqual({ available: true, backend: 'pactl' })
    await adapter.setMuted(true)

    expect(run).toHaveBeenLastCalledWith(
      'pactl',
      ['set-sink-mute', 'alsa_output.speaker_1', '1'],
      undefined
    )
  })

  it('does not treat malformed mixer output as an unmuted snapshot', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl') {
        return { stdout: 'unexpected output\n', stderr: '' }
      }
      if (command === 'pactl' && args[0] === 'get-sink-mute') {
        return { stdout: 'Mute: yes\n', stderr: '' }
      }
      if (command === 'pactl' && args[0] === 'get-default-sink') {
        return { stdout: 'alsa_output.speaker_1\n', stderr: '' }
      }
      throw new Error('not reached')
    })

    await expect(createLinuxPlaybackSuppressionAdapter(run).snapshot()).resolves.toEqual({
      backend: 'pactl',
      endpointId: 'alsa_output.speaker_1',
      endpointTarget: 'alsa_output.speaker_1',
      muted: true
    })
  })

  it('reports unsupported when no known Linux mixer is usable', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async () => {
      throw new Error('ENOENT')
    })
    const adapter = createLinuxPlaybackSuppressionAdapter(run)

    await expect(adapter.getCapability()).resolves.toEqual({
      available: false,
      reason: 'No supported Linux audio mixer was found.'
    })
    await expect(adapter.snapshot()).rejects.toThrow('No supported Linux audio mixer was found.')
  })
})
