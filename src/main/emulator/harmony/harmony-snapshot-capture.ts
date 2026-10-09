import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { ensureHarmonyOk } from './harmony-command-result'
import { hdcTargetArgs } from './hdc-targets'
import type { DeviceScreenSize } from './harmony-input-mapping'

export type SnapshotPaths = { remote: string; local: string }
export type SnapshotResult = { jpeg: Buffer; size: DeviceScreenSize }

export type SnapshotIO = {
  readFile: (path: string) => Promise<Buffer>
}

// Runs snapshot_display only and parses dimensions from stdout — no file recv
// when the JPEG bytes are not needed (orientation/screen-size probes).
export async function captureScreenDimensions(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  remotePath: string
): Promise<DeviceScreenSize> {
  const result = ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, ['shell', 'snapshot_display', '-f', remotePath])
    ),
    'snapshot_display'
  )
  const size = parseSnapshotDimensions(result.stdout)
  if (!size) {
    throw new Error('snapshot_display did not report frame dimensions.')
  }
  return size
}

// snapshot_display stdout: "success: ... as jpeg, width: 1280, height: 2832".
export function parseSnapshotDimensions(stdout: string): DeviceScreenSize | null {
  const match = /width:\s*(\d+)\s*,\s*height:\s*(\d+)/.exec(stdout)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

// Captures one screen: snapshot_display on device → file recv → read the JPEG.
// The remote/local paths are fixed per target (overwritten each cycle), so no
// temp-file accumulation.
export async function captureSnapshot(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  paths: SnapshotPaths,
  io: SnapshotIO
): Promise<SnapshotResult> {
  const snapshot = ensureHarmonyOk(
    await runner(
      sdk.hdc,
      hdcTargetArgs(connectKey, ['shell', 'snapshot_display', '-f', paths.remote])
    ),
    'snapshot_display'
  )
  const size = parseSnapshotDimensions(snapshot.stdout)
  if (!size) {
    throw new Error('snapshot_display did not report frame dimensions.')
  }
  ensureHarmonyOk(
    await runner(sdk.hdc, hdcTargetArgs(connectKey, ['file', 'recv', paths.remote, paths.local])),
    'snapshot recv'
  )
  return { jpeg: await io.readFile(paths.local), size }
}
