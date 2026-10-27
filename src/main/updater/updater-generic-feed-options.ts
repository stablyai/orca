import { WINDOWS_ARM64_UPDATE_CHANNEL } from '../../shared/release-channel'
import { isWindowsArm64 } from '../windows-arm64'

type GenericUpdateFeedOptions = { provider: 'generic'; url: string; channel?: string }

/** electron-updater reads `latest.yml` on every Windows arch; native ARM64 must read its own manifest. */
export function getGenericUpdateFeedOptions(url: string): GenericUpdateFeedOptions {
  return isWindowsArm64()
    ? { provider: 'generic', url, channel: WINDOWS_ARM64_UPDATE_CHANNEL }
    : { provider: 'generic', url }
}
