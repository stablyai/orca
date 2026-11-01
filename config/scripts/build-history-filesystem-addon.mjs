import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nodeGypRebuild, stageNodeAddonApi } from './orcad-prebuild-node-gyp.mjs'

/** Builds an isolated target copy; never overwrites the desktop's loaded addon. */
export async function compileHistoryFilesystemAddon({
  workDir,
  nodeDir,
  staticCxxRuntime = false,
  runProcess
}) {
  const source = resolve(import.meta.dirname, '../../native/history-filesystem')
  const stagedDir = join(workDir, 'history-filesystem')
  rmSync(stagedDir, { recursive: true, force: true })
  mkdirSync(stagedDir, { recursive: true })
  for (const entry of ['package.json', 'binding.gyp', 'src']) {
    cpSync(join(source, entry), join(stagedDir, entry), { recursive: true })
  }
  stageNodeAddonApi(source, stagedDir)
  const buildDir = await nodeGypRebuild({
    stagedDir,
    workDir: stagedDir,
    nodeDir,
    staticCxxRuntime,
    runProcess
  })
  return join(buildDir, 'history_filesystem.node')
}
