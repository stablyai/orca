import { platform, release } from 'node:os'
import { macOSMajorFromDarwinRelease } from '../macos-version'

const NATIVE_LOAD_FAILURE = /dlopen|Symbol not found|Library not loaded|incompatible library/i

// Why: the bundled sherpa-onnx / ONNX Runtime binaries target a newer macOS than
// Orca's declared minimum (12), so on older systems dlopen fails with a raw loader
// dump. Rebuilding the native deps is out of scope; tell the user what to do instead.
export function describeSttNativeLoadError(
  message: string,
  host: { platform: NodeJS.Platform; release: string } = {
    platform: platform(),
    release: release()
  }
): string {
  if (host.platform !== 'darwin' || !NATIVE_LOAD_FAILURE.test(message)) {
    return message
  }
  const macOSMajor = macOSMajorFromDarwinRelease(host.release)
  const version = macOSMajor === null ? 'this macOS version' : `macOS ${macOSMajor}`
  return `On-device speech recognition could not load its native engine on ${version}; it needs a newer macOS than this Mac provides. Update macOS, or use OpenAI transcription instead.\n\n${message}`
}
