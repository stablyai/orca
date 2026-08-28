import { spawnProcess } from '../../shared/child-process/run-process'
import { EmulatorError } from './emulator-errors'

type ChildProcess = ReturnType<typeof spawnProcess>

// `simctl io recordVideo` runs until interrupted and only muxes a playable file
// on SIGINT — SIGKILL leaves a truncated container. This module owns that
// lifecycle: confirm the recording actually started, then stop it cleanly.

// simctl announces readiness on stderr; a bad device instead exits immediately.
const RECORDING_STARTED_RE = /Recording started/i
const START_TIMEOUT_MS = 10_000
// Generous: muxing a long recording to disk can take a beat after SIGINT.
const STOP_GRACE_MS = 15_000
const FORCE_STOP_GRACE_MS = 2_000

export type SimctlRecordingProcess = {
  outputPath: string
  stop(): Promise<void>
}

export type SpawnRecordingProcess = (args: readonly string[]) => ChildProcess

const spawnXcrun: SpawnRecordingProcess = (args) =>
  spawnProcess({ program: 'xcrun', args, stdio: ['ignore', 'ignore', 'pipe'] })

export function buildRecordVideoArgs(udid: string, outputPath: string): string[] {
  // --force overwrites an existing file; h264 keeps the output playable outside Apple players.
  return ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--force', outputPath]
}

export async function startSimctlVideoRecording(
  udid: string,
  outputPath: string,
  spawnRecording: SpawnRecordingProcess = spawnXcrun
): Promise<SimctlRecordingProcess> {
  const child = spawnRecording(buildRecordVideoArgs(udid, outputPath))
  let stderr = ''
  let exit: ProcessExit | null = null
  let onStderr: (() => void) | null = null

  child.stderr?.on('data', (chunk: Buffer | string) => {
    // Bounded: only the tail matters for the failure message.
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
    onStderr?.()
  })

  const exited = new Promise<void>((resolve) => {
    const settle = (next: ProcessExit): void => {
      exit ??= next
      resolve()
    }
    child.once('error', (error) => settle({ code: null, signal: null, spawnError: error }))
    child.once('close', (code, signal) => settle({ code, signal }))
  })

  await waitForRecordingStart(exited, (listener) => {
    onStderr = () => {
      if (RECORDING_STARTED_RE.test(stderr)) {
        listener()
      }
    }
    onStderr()
  })
  onStderr = null

  if (exit) {
    throw recordingStartError(udid, exit, stderr)
  }

  const stop = async (): Promise<void> => {
    if (!exit) {
      child.kill('SIGINT')
      await Promise.race([exited, delay(STOP_GRACE_MS)])
    }
    if (!exit) {
      // The mux is wedged; the file is unusable either way, so stop leaking the process.
      child.kill('SIGKILL')
      await Promise.race([exited, delay(FORCE_STOP_GRACE_MS)])
      throw new EmulatorError(
        'emulator_error',
        `Screen recording for ${udid} did not finish writing ${outputPath} and was force-stopped.`
      )
    }
    // A clean SIGINT stop exits 0; anything else means simctl failed to mux.
    if (exit.code !== 0) {
      throw new EmulatorError(
        'emulator_error',
        `Screen recording for ${udid} failed: ${describeExit(exit, stderr)}`
      )
    }
  }

  return { outputPath, stop }
}

type ProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  spawnError?: Error
}

// Resolves on whichever comes first: the readiness line, process exit, or the timeout.
function waitForRecordingStart(
  exited: Promise<void>,
  subscribeToStderr: (onStarted: () => void) => void
): Promise<void> {
  return new Promise<void>((resolve) => {
    subscribeToStderr(resolve)
    void exited.then(resolve)
    delay(START_TIMEOUT_MS).then(resolve)
  })
}

function recordingStartError(udid: string, exit: ProcessExit, stderr: string): EmulatorError {
  if (exit.spawnError) {
    return new EmulatorError(
      'emulator_simctl_unavailable',
      `Could not run xcrun simctl to record ${udid}: ${exit.spawnError.message}`
    )
  }
  return new EmulatorError(
    'emulator_error',
    `Could not start screen recording for ${udid}: ${describeExit(exit, stderr)}`
  )
}

function describeExit(exit: ProcessExit, stderr: string): string {
  const detail = stderr.trim()
  if (detail) {
    return detail
  }
  return exit.signal ? `stopped by ${exit.signal}` : `xcrun simctl exited with code ${exit.code}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}
