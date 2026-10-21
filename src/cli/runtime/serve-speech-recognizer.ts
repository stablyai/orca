import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { speechRecognizerPackageName } from '../../shared/speech-recognizer-package'

/**
 * The installed app's on-device recognizer, for orcad's dictation (#31174). electron-builder puts
 * it in `resources/node_modules`, beside the app root; a dev checkout keeps it in node_modules.
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
  const name = speechRecognizerPackageName(platform, arch)
  return [join(dirname(appRoot), 'node_modules', name), join(appRoot, 'node_modules', name)].find(
    (dir) => existsSync(join(dir, 'sherpa-onnx.node'))
  )
}
