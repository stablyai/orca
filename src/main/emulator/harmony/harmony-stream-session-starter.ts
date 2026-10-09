import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { captureSnapshot } from './harmony-snapshot-capture'
import { startHarmonyMjpegServer } from './harmony-mjpeg-server'

export type HarmonyStreamHandle = { close: () => void }

export type StartHarmonyStreamParams = {
  runner: HarmonyCommandRunner
  sdk: HarmonySdkPaths
  connectKey: string
  frameIntervalMs?: number
}

export type StartHarmonyStream = (
  params: StartHarmonyStreamParams
) => Promise<{ info: EmulatorSessionInfo; handle: HarmonyStreamHandle }>

const REMOTE_SNAPSHOT_PATH = '/data/local/tmp/orca-snapshot.jpeg'

// connectKey -> local JPEG path ("127.0.0.1:5555" -> "orca-harmony-127-0-0-1-5555.jpeg").
export function localSnapshotPath(connectKey: string): string {
  return join(tmpdir(), `orca-harmony-${connectKey.replace(/[^a-zA-Z0-9]/g, '-')}.jpeg`)
}

// Starts the MJPEG server for a booted target; each served frame triggers one
// snapshot_display + file recv. Returns session info (mjpeg) and a teardown handle.
export const startHarmonyStreamSession: StartHarmonyStream = async ({
  runner,
  sdk,
  connectKey,
  frameIntervalMs
}) => {
  const paths = { remote: REMOTE_SNAPSHOT_PATH, local: localSnapshotPath(connectKey) }
  const server = await startHarmonyMjpegServer({
    frameIntervalMs,
    captureFrame: async () =>
      (
        await captureSnapshot(runner, sdk, connectKey, paths, {
          readFile: (path) => readFile(path)
        })
      ).jpeg
  })

  let closed = false
  return {
    info: harmonyStreamSessionInfo(connectKey, server.streamUrl),
    handle: {
      close: () => {
        if (closed) {
          return
        }
        closed = true
        void server.stop()
      }
    }
  }
}

export function harmonyStreamSessionInfo(
  connectKey: string,
  streamUrl: string
): EmulatorSessionInfo {
  return {
    deviceUdid: connectKey,
    wsUrl: '',
    streamUrl,
    streamCodec: 'mjpeg',
    backend: 'harmonyos'
  }
}
