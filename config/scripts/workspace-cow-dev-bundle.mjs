import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function getWorkspaceCloneHelperHash(repoRoot) {
  return createHash('sha256')
    .update(readFileSync(join(repoRoot, 'native/workspace-cow-macos/main.c')))
    .update(readFileSync(join(repoRoot, 'config/scripts/build-workspace-cow-macos.mjs')))
    .digest('hex')
}

export function buildDevWorkspaceCloneHelper(repoRoot, appPath) {
  try {
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'config/scripts/build-workspace-cow-macos.mjs'),
        '--single-arch',
        '--output',
        join(appPath, 'Contents', 'MacOS', 'orca-workspace-cow')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(`[orca-dev] workspace clone helper unavailable: ${error?.message ?? error}`)
  }
}
