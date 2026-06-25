import { resolveMacOSComputerUseExecutablePath } from './macos-native-provider-paths'
import { isMacOS14OrNewer } from './macos-native-provider-transport'

export function shouldUseMacOSNativeProvider(): boolean {
  return (
    process.platform === 'darwin' &&
    isMacOS14OrNewer() &&
    resolveMacOSComputerUseExecutablePath() !== null
  )
}
