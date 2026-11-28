import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { PinnedDaemonVersionsEvidence } from './daemon-host-pinned-versions'
import {
  reclaimAbandonedDaemonHostStaging,
  reclaimUnownedDaemonHostDir
} from './daemon-host-reclaim'
import { getDaemonHostRootDir, isPackagedElectronWin32 } from './daemon-host-relocation'

/** Pass `recheck` to re-read pid evidence right before each delete, so a version pinned since the snapshot survives. */
export async function pruneOldDaemonHosts(
  evidence: PinnedDaemonVersionsEvidence,
  recheck?: () => Promise<PinnedDaemonVersionsEvidence>
): Promise<void> {
  if (!isPackagedElectronWin32()) {
    return
  }
  // Decide on version dirs first: awaiting staging cleanup before them would let the pid evidence go stale.
  // A prune already running owns the same dirs; joining it avoids a second whole-tree walk.
  inFlightVersionPrune ??= pruneSupersededVersions(evidence, recheck).finally(() => {
    inFlightVersionPrune = null
  })
  await inFlightVersionPrune
  await pruneDaemonHostStaging()
}

let inFlightVersionPrune: Promise<void> | null = null
let inFlightStagingPrune: Promise<void> | null = null

function exitedIn(evidence: PinnedDaemonVersionsEvidence, version: string): boolean {
  // Only a complete runtime-directory listing permits treating unrecorded versions as unowned.
  return (
    evidence.status === 'complete' &&
    (evidence.versionLiveness.get(version) ?? { status: 'exited' }).status === 'exited'
  )
}

// Cross-process race left: a version can still publish between this re-check and the delete; a shared lock would close it.
async function pruneSupersededVersions(
  evidence: PinnedDaemonVersionsEvidence,
  recheck: (() => Promise<PinnedDaemonVersionsEvidence>) | undefined
): Promise<void> {
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
    if (!exitedIn(evidence, entry.name) || (recheck && !exitedIn(await recheck(), entry.name))) {
      continue
    }
    await reclaimUnownedDaemonHostDir({ status: 'exited' }, join(root, entry.name))
  }
}

/** Reclaim only copies whose writer positively exited, independently of daemon pid publication. */
export async function pruneDaemonHostStaging(): Promise<void> {
  if (!isPackagedElectronWin32()) {
    return
  }
  // The launcher and provider init both start this; one walk serves both.
  inFlightStagingPrune ??= reclaimAbandonedDaemonHostStaging(
    join(getDaemonHostRootDir(), getAppEnvironment().getVersion())
  ).finally(() => {
    inFlightStagingPrune = null
  })
  await inFlightStagingPrune
}
