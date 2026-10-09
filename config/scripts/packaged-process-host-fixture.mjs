import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const requireFromBuilder = createRequire(require.resolve('electron-builder/package.json'))
const { copyFiles, FileMatcher } = requireFromBuilder('app-builder-lib/out/fileMatcher')
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

export async function stagePackagedProcessHost(resourcesDir) {
  const resource = createPackagedRuntimeNodeModuleResources().find(
    (entry) => entry.to === join('node_modules', '@orca', 'process-host')
  )
  if (!resource) {
    throw new Error('Packaged process-host resource is missing')
  }
  const packageDir = join(resourcesDir, resource.to)
  await copyFiles([new FileMatcher(resource.from, packageDir, (value) => value, resource.filter)])
  return packageDir
}
