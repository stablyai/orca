import { resolveMacOSComputerUseExecutablePath } from './macos-native-provider-paths'
import { isMacOS13OrNewer } from './macos-native-provider-transport'

export function shouldUseMacOSNativeProvider(): boolean {
  return (
    process.platform === 'darwin' &&
    isMacOS13OrNewer() &&
    resolveMacOSComputerUseExecutablePath() !== null
  )
}
