import { dirname, join } from 'node:path'
import { hasSpeechEnginePackage } from '../../shared/speech-recognizer-package'

/**
 * The installed app's node_modules holding transcribe-cpp, for orcad's on-device dictation
 * (#31174). electron-builder puts it in `resources/node_modules`, beside the app root; a dev
 * checkout keeps it in node_modules.
 *
 * Not on Windows: a loaded addon locks its files for the server's life, which would make the next
 * app update fail to replace them. Windows orcad keeps cloud dictation only.
 */
export function findAppSpeechRecognizerDir(
  appRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): string | undefined {
  if (platform === 'win32') {
    return undefined
  }
  return [join(dirname(appRoot), 'node_modules'), join(appRoot, 'node_modules')].find((dir) =>
    hasSpeechEnginePackage(dir, platform, arch)
  )
}
