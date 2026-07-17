import { execFile } from 'node:child_process'
import type {
  PlaybackSuppressionAdapter,
  PlaybackSuppressionSnapshot
} from './playback-suppression-service'

type CommandResult = { stdout: string; stderr: string }

export type PlaybackSuppressionCommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal
) => Promise<CommandResult>

type LinuxBackend = 'wpctl' | 'pactl'

const UNSUPPORTED_REASON = 'No supported Linux audio mixer was found.'

const backendProbes: {
  backend: LinuxBackend
  command: string
  args: string[]
  parseMuted: (stdout: string) => boolean | null
}[] = [
  {
    backend: 'wpctl',
    command: 'wpctl',
    args: ['get-volume', '@DEFAULT_AUDIO_SINK@'],
    parseMuted: (stdout) => (/Volume:\s*\d/i.test(stdout) ? /\[MUTED\]/i.test(stdout) : null)
  },
  {
    backend: 'pactl',
    command: 'pactl',
    args: ['get-sink-mute', '@DEFAULT_SINK@'],
    parseMuted: (stdout) => {
      const match = /Mute:\s*(yes|no)/i.exec(stdout)
      return match ? match[1]?.toLowerCase() === 'yes' : null
    }
  }
]

export function runPlaybackSuppressionCommand(
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 750, signal }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export function createLinuxPlaybackSuppressionAdapter(
  run: PlaybackSuppressionCommandRunner = runPlaybackSuppressionCommand
): PlaybackSuppressionAdapter {
  let selectedBackend: LinuxBackend | null = null
  let selectedEndpointTarget: string | undefined

  const readEndpoint = async (
    backend: LinuxBackend,
    signal?: AbortSignal
  ): Promise<{ endpointId: string; endpointTarget: string }> => {
    switch (backend) {
      case 'wpctl': {
        const { stdout } = await run('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'], signal)
        const endpointId = /node\.name\s*=\s*"([^"]+)"/i.exec(stdout)?.[1]
        const endpointTarget = /^id\s+(\d+),/im.exec(stdout)?.[1]
        if (!endpointId || !endpointTarget) {
          throw new Error('Could not identify the default wpctl endpoint.')
        }
        return { endpointId, endpointTarget }
      }
      case 'pactl': {
        const { stdout } = await run('pactl', ['get-default-sink'], signal)
        const endpointId = stdout.trim()
        if (!endpointId) {
          throw new Error('Could not identify the default pactl endpoint.')
        }
        return { endpointId, endpointTarget: endpointId }
      }
    }
  }

  const probe = async (signal?: AbortSignal): Promise<PlaybackSuppressionSnapshot> => {
    for (const candidate of backendProbes) {
      try {
        const { stdout } = await run(candidate.command, candidate.args, signal)
        const muted = candidate.parseMuted(stdout)
        if (muted === null) {
          continue
        }
        selectedBackend = candidate.backend
        const endpoint = await readEndpoint(candidate.backend, signal)
        selectedEndpointTarget = endpoint.endpointTarget
        return {
          backend: candidate.backend,
          ...endpoint,
          muted
        }
      } catch {
        // Try the next local mixer backend.
      }
    }
    throw new Error(UNSUPPORTED_REASON)
  }

  const getCapability = async (): Promise<boolean> => {
    try {
      await probe()
      return true
    } catch {
      return false
    }
  }

  const setMuted = async (
    muted: boolean,
    signal?: AbortSignal,
    snapshot?: PlaybackSuppressionSnapshot
  ): Promise<void> => {
    if (!selectedBackend) {
      await probe(signal)
    }
    const endpointTarget = snapshot?.endpointTarget ?? selectedEndpointTarget
    const backend = snapshot?.backend ?? selectedBackend
    switch (backend) {
      case 'wpctl':
        await run(
          'wpctl',
          ['set-mute', endpointTarget ?? '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0'],
          signal
        )
        return
      case 'pactl':
        await run(
          'pactl',
          ['set-sink-mute', endpointTarget ?? '@DEFAULT_SINK@', muted ? '1' : '0'],
          signal
        )
        return
      case null:
      default:
        throw new Error(UNSUPPORTED_REASON)
    }
  }

  return { getCapability, snapshot: probe, setMuted }
}
