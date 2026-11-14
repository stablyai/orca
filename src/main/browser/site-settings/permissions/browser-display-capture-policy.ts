import { compareDottedVersions } from '../../../orcad/native-host-abi'

// ScreenCaptureKit's content-sharing picker; older macOS has no system picker.
const SYSTEM_PICKER_DARWIN_MINIMUM_OS = '15.0.0'

/** Screen sharing is allowed only where the OS picker, not the page or an agent, chooses the source. */
export function hasBrowserDisplayCaptureSystemPicker(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const systemVersion = process.getSystemVersion?.()
  return (
    !!systemVersion && compareDottedVersions(systemVersion, SYSTEM_PICKER_DARWIN_MINIMUM_OS) >= 0
  )
}
