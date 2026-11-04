import { writeFileSync } from 'node:fs'
import { getDefaultPersistedState } from '../../../shared/constants'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'

export async function buildCanonicalRunWorkers(bundleRoot: string): Promise<void> {
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts'),
      resolve('src/main/workspace-surfaces/surface-executor-reader-entry.ts')
    ],
    outdir: bundleRoot,
    entryNames: '[name]',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
}

export function canonicalRunWorkerOptions(bundleRoot: string) {
  return {
    workerPath: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    backupWorkerPath: join(bundleRoot, 'profile-state-backup-worker-entry.js')
  }
}

export function seedCanonicalMoveProfile(
  directory: string,
  pane: { worktreeId: string; tabId: string; leafId: string }
): void {
  const state = getDefaultPersistedState(directory)
  state.sshRemotePtyLeases = [
    {
      targetId: 'host',
      ptyId: 'pending-resource',
      createdAt: 1,
      updatedAt: 1,
      ...pane,
      state: 'attached'
    }
  ]
  writeFileSync(join(directory, 'orca-data.json'), JSON.stringify(state))
}
