import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'

import {
  mkTempProject,
  runRebuildScript,
  writeFakeElectronRebuild,
  writeFakeNodePtyConptyPayload,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTreeWithNodeAddonApi
} from './rebuild-native-deps-test-fixtures.mjs'

const require = createRequire(import.meta.url)

/** A real loadable addon, so the OS holds the same lock a running Orca holds. */
function repoAddonPath() {
  try {
    const entry = require.resolve('@vscode/windows-process-tree')
    const built = join(entry, '..', '..', 'build', 'Release', 'windows_process_tree.node')
    return existsSync(built) ? built : null
  } catch {
    return null
  }
}

/**
 * Stage a stale addon and keep it loaded, exactly as a running Orca does.
 *
 * The bytes are the repo's own patched build with the flagged import appended,
 * because the guard keys on that symbol and the patched binary does not carry
 * it. Trailing bytes are PE overlay, so the file still loads.
 */
async function stageLoadedStaleAddon(projectDir) {
  const source = repoAddonPath()
  const releaseDir = join(
    projectDir,
    'node_modules',
    '@vscode',
    'windows-process-tree',
    'build',
    'Release'
  )
  mkdirSync(releaseDir, { recursive: true })
  const stale = join(releaseDir, 'windows_process_tree.node')
  copyFileSync(source, stale)
  appendFileSync(stale, 'ReadProcessMemory')

  const holder = spawn(
    process.execPath,
    ['-e', 'require(process.argv[1]); process.send("held"); setInterval(() => {}, 1000)', stale],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  await new Promise((resolve, reject) => {
    holder.once('message', resolve)
    holder.once('exit', () => reject(new Error('the addon holder exited before loading')))
  })
  return holder
}

// Why an end-to-end run: the defect was purely one of placement. The guard threw
// a real EPERM, and the classifier that turns that into "close running Orca"
// already existed -- the throw simply happened before the try that reaches it.
// Only the whole script exercises that.
describe.runIf(process.platform === 'win32')('rebuild-native-deps stale addon under lock', () => {
  it.skipIf(!repoAddonPath())(
    'reports a locked stale addon as a Windows file lock instead of an EPERM stack',
    async () => {
      const projectDir = mkTempProject()
      let holder

      try {
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)
        writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)
        holder = await stageLoadedStaleAddon(projectDir)

        const result = runRebuildScript(
          projectDir,
          {
            npm_lifecycle_event: 'postinstall',
            npm_config_platform: 'win32',
            npm_config_arch: process.arch
          },
          ['--platform=win32', `--arch=${process.arch}`, '--force']
        )

        expect(result.stderr).toContain(
          'Close running Orca/Electron/dev processes for this worktree'
        )
        // Non-strict postinstall soft-exits on a lock; the next dev/start re-checks.
        expect(result.status, result.stderr).toBe(0)
      } finally {
        holder?.kill()
        removeTreeSync(projectDir)
      }
    }
  )
})
