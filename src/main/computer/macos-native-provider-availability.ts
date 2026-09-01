import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'
import { getMacOSComputerUseHelperCompatibility } from './macos-computer-use-helper-compatibility'

export function shouldUseMacOSNativeProvider(): boolean {
  if (process.platform !== 'darwin' || resolveMacOSComputerUseExecutablePath() === null) {
    return false
  }
  const helperAppPath = resolveMacOSComputerUseAppPath()
  return (
    helperAppPath !== null &&
    getMacOSComputerUseHelperCompatibility(helperAppPath)?.compatible === true
  )
}
