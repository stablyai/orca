/**
 * The addons a compat slot builds beside node-pty (design D6 rung B). The default slots take
 * @parcel/watcher's upstream prebuild, which needs a newer libstdc++ than a glibc 2.17 host has,
 * so the compat slot compiles it from the package's own sources with the C++ runtime static.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { nodeGypRebuild, stageNodeAddonApi } from './orcad-prebuild-node-gyp.mjs'
import { COMPAT_SLOT_ADDONS, SLOT_NAPI_VERSION } from './orcad-prebuild-slot-contents.mjs'

const require = createRequire(import.meta.url)

const BUILDERS = {
  'parcel-watcher/watcher.node': compileParcelWatcher
}

/** `[slot-relative path, built file]` for every compat addon, compiled under `workDir`. */
export async function compileCompatAddons({ slot, workDir, nodeDir }) {
  const built = []
  for (const relative of Object.keys(COMPAT_SLOT_ADDONS)) {
    const builder = BUILDERS[relative]
    if (!builder) {
      throw new Error(`[orcad-prebuilds] no builder for compat addon ${relative}`)
    }
    built.push([relative, await builder({ slot, workDir, nodeDir })])
  }
  return built
}

async function compileParcelWatcher({ slot, workDir, nodeDir }) {
  const sourceDir = dirname(require.resolve('@parcel/watcher/package.json'))
  const addonWorkDir = join(workDir, 'parcel-watcher')
  const stagedDir = join(addonWorkDir, 'watcher')
  rmSync(addonWorkDir, { recursive: true, force: true })
  mkdirSync(stagedDir, { recursive: true })
  for (const entry of ['package.json', 'binding.gyp', 'src']) {
    cpSync(join(sourceDir, entry), join(stagedDir, entry), { recursive: true })
  }
  stageNodeAddonApi(sourceDir, stagedDir)
  console.log(
    `[orcad-prebuilds] compiling @parcel/watcher for ${slot} against Node ${NODE_RUNTIME_PIN.version} headers, N-API ${SLOT_NAPI_VERSION} ...`
  )
  const buildDir = await nodeGypRebuild({
    stagedDir,
    workDir: addonWorkDir,
    nodeDir,
    staticCxxRuntime: true
  })
  return join(buildDir, 'watcher.node')
}
