// node-gyp rebuild of one staged addon against the pinned Node headers, shared by every slot addon.
import { cpSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { prebuildCompileGypi } from './orcad-prebuild-slot-contents.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..', '..')

/** Copies node-addon-api beside a staged addon, since scratch copies leave the pnpm tree behind. */
export function stageNodeAddonApi(sourceDir, stagedDir) {
  const addonApiDir = dirname(
    require.resolve('node-addon-api/package.json', { paths: [sourceDir] })
  )
  cpSync(addonApiDir, join(stagedDir, 'node_modules', 'node-addon-api'), {
    recursive: true,
    dereference: true
  })
}

export async function nodeGypRebuild({ stagedDir, workDir, nodeDir, staticCxxRuntime }) {
  const compileGypi = join(workDir, 'prebuild-compile.gypi')
  writeFileSync(compileGypi, prebuildCompileGypi({ staticCxxRuntime }))
  const { runProcessSync } = await import('./script-child-process.mjs')
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      'rebuild',
      `--nodedir=${nodeDir}`,
      '--',
      '-I',
      compileGypi
    ],
    cwd: stagedDir,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`[orcad-prebuilds] node-gyp rebuild failed (status ${result.code})`)
  }
  return join(stagedDir, 'build', 'Release')
}
