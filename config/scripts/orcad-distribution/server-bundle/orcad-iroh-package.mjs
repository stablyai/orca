import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ORCAD_IROH_DIR } from '../../../../src/shared/orcad-artifacts.ts'
import { verifyIrohPrebuild } from '../prebuilds/iroh-prebuild.mjs'
import { readManifest } from '../prebuilds/orcad-prebuild-slot-contents.mjs'

/** Stage the pinned loader with its verified Linux x64 floor artifact; other targets omit iroh. */
export async function stageOrcadIroh(root, outputDir, target, prebuildsDir) {
  if (target !== 'linux-x64-glibc') {
    return
  }
  try {
    if (!prebuildsDir) {
      throw new Error('A verified Iroh prebuild directory is required')
    }
    const require = createRequire(join(root, 'package.json'))
    const packagePath = require.resolve('@number0/iroh/package.json')
    const sourceDir = dirname(packagePath)
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
    const nativeSource = verifyIrohPrebuild({
      slotDir: join(prebuildsDir, target),
      slot: target,
      entry: readManifest(prebuildsDir)?.slots?.[target],
      version: metadata.version
    })
    const destination = join(outputDir, ORCAD_IROH_DIR)
    mkdirSync(destination, { recursive: true })
    // Keep the loader's explicit CJS exports for dynamic import's named exports.
    copyFileSync(join(sourceDir, 'index.js'), join(destination, 'index.js'))
    copyFileSync(nativeSource, join(destination, 'iroh.linux-x64-gnu.node'))
    // Published 1.1.0 points at nonexistent iroh-js/index.js; normalize only the staged copy.
    writeFileSync(
      join(destination, 'package.json'),
      `${JSON.stringify({ ...metadata, main: 'index.js' }, null, 2)}\n`
    )
  } catch (cause) {
    throw new Error(
      `Cannot stage Orcad ${target} Iroh from @number0/iroh and its verified native floor prebuild: ${cause.message}`,
      { cause }
    )
  }
}
