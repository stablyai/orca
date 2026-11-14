import type { EventProps } from '../../shared/telemetry-events'
import type { HangDetectionMarker } from './hang-detection-marker'
import {
  listNativeHangCaptures,
  nativeHangCaptureDirectory,
  readNativeHangCapture
} from './native-hang-capture-store'
import { reduceNativeHangSample } from './native-hang-capture'

export type NativeHangTelemetry = Pick<
  EventProps<'main_thread_hang_detected'>,
  'native_top_frames' | 'macos_build' | 'menu_bar_icon'
>

export async function readPreviousNativeHangTelemetry(
  userDataPath: string,
  marker: HangDetectionMarker
): Promise<NativeHangTelemetry> {
  const directory = nativeHangCaptureDirectory(userDataPath)
  for (const file of await listNativeHangCaptures(directory)) {
    if (file.detectedAt !== marker.detectedAt) {
      continue
    }
    const capture = await readNativeHangCapture(directory, file.captureId)
    if (!capture || capture.artifact.pid !== marker.parentPid) {
      continue
    }
    const artifact = capture.artifact
    const macosBuild = /^OS Version:\s*(macOS \d+(?:\.\d+){0,3} \([A-Za-z0-9]+\))\s*$/m.exec(
      artifact.report
    )?.[1]
    return {
      native_top_frames: reduceNativeHangSample(artifact.report).stacks.flatMap((stack) =>
        stack.frames.map((frame) => `${frame.name} [${frame.module}]`)
      ),
      ...(macosBuild && macosBuild.length <= 64 ? { macos_build: macosBuild } : {}),
      menu_bar_icon: artifact.showMenuBarIcon
    }
  }
  return {}
}
