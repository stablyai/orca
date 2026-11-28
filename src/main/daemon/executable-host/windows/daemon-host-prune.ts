import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { PinnedDaemonVersionsEvidence } from './daemon-host-pinned-versions'
import {
  reclaimAbandonedDaemonHostStaging,
  reclaimUnownedDaemonHostDir
} from './daemon-host-reclaim'
import { getDaemonHostRootDir, isPackagedElectronWin32 } from './daemon-host-relocation'

export async function pruneOldDaemonHosts(evidence: PinnedDaemonVersionsEvidence): Promise<void> {
  if (!isPackagedElectronWin32()) {
    return
  }
  await pruneDaemonHostStaging()
  if (evidence.status === 'unverifiable') {
    console.warn(`[daemon] Skipping daemon-host prune: ${evidence.reason}`)
    return
  }
  const version = getAppEnvironment().getVersion()
  const root = getDaemonHostRootDir()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // A published current-version build can belong to a daemon that has not written its pid yet.
    if (!entry.isDirectory() || entry.name === version) {
      continue
    }
    // Only a complete runtime-directory listing permits treating unrecorded versions as unowned.
    const verdict = evidence.versionLiveness.get(entry.name) ?? { status: 'exited' }
    await reclaimUnownedDaemonHostDir(verdict, join(root, entry.name))
  }
}

/** Reclaim only copies whose writer positively exited, independently of daemon pid publication. */
export async function pruneDaemonHostStaging(): Promise<void> {
  if (isPackagedElectronWin32()) {
    await reclaimAbandonedDaemonHostStaging(
      join(getDaemonHostRootDir(), getAppEnvironment().getVersion())
    )
  }
}
