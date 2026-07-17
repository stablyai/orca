import { execFile } from 'node:child_process'
import type {
  PlaybackSuppressionAdapter,
  PlaybackSuppressionSnapshot
} from './playback-suppression-service'
import type { PlaybackSuppressionCapability } from '../../shared/speech-types'

type CommandResult = { stdout: string; stderr: string }

export type PlaybackSuppressionCommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal
) => Promise<CommandResult>

type LinuxBackend = 'wpctl' | 'pactl' | 'amixer'

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
  },
  {
    backend: 'amixer',
    command: 'amixer',
    args: ['get', 'Master'],
    parseMuted: (stdout) => {
      const match = /\[(on|off)\]/i.exec(stdout)
      return match ? match[1]?.toLowerCase() === 'off' : null
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

  const probe = async (signal?: AbortSignal): Promise<PlaybackSuppressionSnapshot> => {
    for (const candidate of backendProbes) {
      try {
        const { stdout } = await run(candidate.command, candidate.args, signal)
        const muted = candidate.parseMuted(stdout)
        if (muted === null) {
          continue
        }
        selectedBackend = candidate.backend
        return { backend: candidate.backend, muted }
      } catch {
        // Try the next local mixer backend.
      }
    }
    throw new Error(UNSUPPORTED_REASON)
  }

  const getCapability = async (): Promise<PlaybackSuppressionCapability> => {
    try {
      const snapshot = await probe()
      return { available: true, backend: snapshot.backend }
    } catch {
      return { available: false, reason: UNSUPPORTED_REASON }
    }
  }

  const setMuted = async (muted: boolean, signal?: AbortSignal): Promise<void> => {
    if (!selectedBackend) {
      await probe(signal)
    }
    switch (selectedBackend) {
      case 'wpctl':
        await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0'], signal)
        return
      case 'pactl':
        await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0'], signal)
        return
      case 'amixer':
        await run('amixer', ['set', 'Master', muted ? 'mute' : 'unmute'], signal)
        return
      case null:
        throw new Error(UNSUPPORTED_REASON)
    }
  }

  return { getCapability, snapshot: probe, setMuted }
}
