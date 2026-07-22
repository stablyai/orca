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

    expect(run).toHaveBeenNthCalledWith(4, 'wpctl', ['set-mute', '118', '1'], undefined)
    expect(run).toHaveBeenNthCalledWith(6, 'wpctl', ['set-mute', '118', '0'], undefined)
  })

  it('preserves a muted wpctl snapshot', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (_command, args) =>
      args[0] === 'inspect'
        ? {
            stdout:
              'id 118, type PipeWire:Interface:Node\n  * node.name = "bluez_output.speaker_1"\n',
            stderr: ''
          }
        : { stdout: 'Volume: 0.58 [MUTED]\n', stderr: '' }
    )

    await expect(createLinuxPlaybackSuppressionAdapter(run).snapshot()).resolves.toEqual({
      backend: 'wpctl',
      endpointId: 'bluez_output.speaker_1',
      endpointTarget: '118',
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

    await expect(adapter.getCapability()).resolves.toBe(true)
    await adapter.setMuted(true)

    expect(run).toHaveBeenLastCalledWith(
      'pactl',
      ['set-sink-mute', 'alsa_output.speaker_1', '1'],
      undefined
    )
  })

  it('restores through the backend captured in the snapshot', async () => {
    let wpctlAvailable = true
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl' && args[0] === 'get-volume' && wpctlAvailable) {
        return { stdout: 'Volume: 0.58\n', stderr: '' }
      }
      if (command === 'wpctl' && args[0] === 'inspect' && (wpctlAvailable || args[1] === '118')) {
        return {
          stdout:
            'id 118, type PipeWire:Interface:Node\n  * node.name = "bluez_output.speaker_1"\n',
          stderr: ''
        }
      }
      if (command === 'wpctl' && args[0] === 'get-volume') {
        throw new Error('temporarily unavailable')
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
    const snapshot = await adapter.snapshot()
    wpctlAvailable = false

    await adapter.getCapability()
    await adapter.setMuted(false, undefined, snapshot)

    expect(run).toHaveBeenLastCalledWith('wpctl', ['set-mute', '118', '0'], undefined)
  })

  it('refuses to restore a wpctl node ID that now belongs to another endpoint', async () => {
    let endpointId = 'bluez_output.speaker_1'
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl' && args[0] === 'get-volume') {
        return { stdout: 'Volume: 0.58\n', stderr: '' }
      }
      if (command === 'wpctl' && args[0] === 'inspect') {
        return {
          stdout: `id 118, type PipeWire:Interface:Node\n  * node.name = "${endpointId}"\n`,
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })
    const adapter = createLinuxPlaybackSuppressionAdapter(run)
    const snapshot = await adapter.snapshot()
    endpointId = 'bluez_output.speaker_2'

    await expect(adapter.setMuted(false, undefined, snapshot)).rejects.toThrow(
      'captured wpctl endpoint'
    )
    expect(run).not.toHaveBeenCalledWith('wpctl', ['set-mute', '118', '0'], undefined)
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

  it('falls back when wpctl cannot identify an exact endpoint target', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command, args) => {
      if (command === 'wpctl' && args[0] === 'get-volume') {
        return { stdout: 'Volume: 0.58\n', stderr: '' }
      }
      if (command === 'wpctl' && args[0] === 'inspect') {
        return { stdout: 'unrecognized output\n', stderr: '' }
      }
      if (command === 'pactl' && args[0] === 'get-sink-mute') {
        return { stdout: 'Mute: no\n', stderr: '' }
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
      muted: false
    })
  })

  it('does not advertise amixer without an exact device target', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async (command) => {
      if (command === 'amixer') {
        return { stdout: "Simple mixer control 'Master',0\n  Front Left: [on]\n", stderr: '' }
      }
      throw new Error('ENOENT')
    })

    await expect(createLinuxPlaybackSuppressionAdapter(run).getCapability()).resolves.toBe(false)
  })

  it('reports unsupported when no known Linux mixer is usable', async () => {
    const run = vi.fn<PlaybackSuppressionCommandRunner>(async () => {
      throw new Error('ENOENT')
    })
    const adapter = createLinuxPlaybackSuppressionAdapter(run)

    await expect(adapter.getCapability()).resolves.toBe(false)
    await expect(adapter.snapshot()).rejects.toThrow('No supported Linux audio mixer was found.')
  })
})
