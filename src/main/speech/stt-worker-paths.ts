import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

export function getSttWorkerPath(): string {
  if (getAppEnvironment().isPackaged()) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'stt-worker.js')
  }
  return join(__dirname, 'stt-worker.js')
}

export function getSherpaModulePath(): string {
  const nativePackage =
    process.platform === 'win32' && process.arch === 'x64'
      ? 'sherpa-onnx-win-x64'
      : `sherpa-onnx-${process.platform}-${process.arch}`

  if (getAppEnvironment().isPackaged()) {
    const resourcesNodeModule = join(process.resourcesPath, 'node_modules', nativePackage)
    if (existsSync(resourcesNodeModule)) {
      return resourcesNodeModule
    }
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePackage)
  }

  const resolved = require.resolve(nativePackage)
  return join(resolved, '..')
}
