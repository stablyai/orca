import { execFile } from 'node:child_process'
import type {
  PlaybackSuppressionAdapter,
  PlaybackSuppressionSnapshot
} from './playback-suppression-service'

type CommandResult = { stdout: string; stderr: string }

export type NativePlaybackSuppressionRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal
) => Promise<CommandResult>

type NativePlaybackSuppressionOptions = {
  backend: string
  executablePath: string
  run?: NativePlaybackSuppressionRunner
}

function runNativePlaybackSuppression(
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 1_000, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

function parseSnapshot(stdout: string, backend: string): PlaybackSuppressionSnapshot {
  const parsed: unknown = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Native audio helper did not return a restorable output endpoint.')
  }
  const value = parsed as Record<string, unknown>
  if (
    typeof value.endpointId !== 'string' ||
    value.endpointId.length === 0 ||
    typeof value.endpointTarget !== 'string' ||
    value.endpointTarget.length === 0 ||
    typeof value.muted !== 'boolean'
  ) {
    throw new Error('Native audio helper did not return a restorable output endpoint.')
  }
  return {
    backend,
    endpointId: value.endpointId,
    endpointTarget: value.endpointTarget,
    muted: value.muted
  }
}

export function createNativePlaybackSuppressionAdapter(
  options: NativePlaybackSuppressionOptions
): PlaybackSuppressionAdapter {
  const run = options.run ?? runNativePlaybackSuppression

  const snapshot = async (signal?: AbortSignal): Promise<PlaybackSuppressionSnapshot> => {
    const { stdout } = await run(options.executablePath, ['snapshot'], signal)
    return parseSnapshot(stdout, options.backend)
  }

  const getCapability = async (): Promise<boolean> => {
    try {
      await snapshot()
      return true
    } catch {
      return false
    }
  }

  const setMuted = async (
    muted: boolean,
    signal?: AbortSignal,
    captured?: PlaybackSuppressionSnapshot
  ): Promise<void> => {
    if (captured?.backend !== options.backend || !captured.endpointId || !captured.endpointTarget) {
      throw new Error('Native audio muting requires a captured output endpoint.')
    }
    await run(
      options.executablePath,
      [
        'set-muted',
        '--endpoint-id',
        captured.endpointId,
        '--endpoint-target',
        captured.endpointTarget,
        String(muted)
      ],
      signal
    )
  }

  return { getCapability, snapshot, setMuted }
}
