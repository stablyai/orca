// Reset the folder-class TCC grant, prompt from Orca, then probe whether a fresh daemon can read it.

import { app } from 'electron'
import { dirname, resolve } from 'node:path'
import {
  isMacTccFolderClass,
  type DaemonPtyCwdClass,
  type MacTccFolderClass
} from '../../shared/daemon-adoption-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { readMacosBundleId, resetMacosTccPermission } from '../macos-tcc-reset'
import { enumerateDirectoryOnce } from './directory-enumeration-probe'
import { track } from '../telemetry/client'
import {
  getDaemonFolderAccessMismatch,
  getDaemonFolderAccessTarget,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice,
  type FreshDaemonAccess
} from './daemon-folder-access-mismatch'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

export type DaemonFolderAccessResetResult =
  | { outcome: 'unsupported' }
  | { outcome: 'reset_failed' }
  | { outcome: 'probed'; mismatch: DaemonFolderAccessMismatchNotice | null }

const TCC_SERVICE_BY_CWD_CLASS: Record<MacTccFolderClass, string> = {
  documents: 'SystemPolicyDocumentsFolder',
  desktop: 'SystemPolicyDesktopFolder',
  downloads: 'SystemPolicyDownloadsFolder'
}

/** Orca.app/Contents/MacOS/Orca → Orca.app, whose bundle ID identifies its TCC grants. */
function runningAppBundlePath(): string {
  return resolve(dirname(app.getPath('exe')), '..', '..')
}

/** An unanswered macOS sheet must not keep the fix dialog busy for the rest of the session. */
const PROMPT_DEADLINE_MS = 60_000

/** Read from the app to attribute the TCC prompt to Orca; async I/O keeps main responsive.
 * A deadline stops waiting but cannot cancel an unanswered prompt's read. */
async function promptByReadingFolder(path: string): Promise<boolean> {
  let deadline: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      // This read triggers the prompt; the fresh-daemon probe judges access.
      enumerateDirectoryOnce(path).then(() => true),
      new Promise<false>((resolve) => {
        deadline = setTimeout(() => resolve(false), PROMPT_DEADLINE_MS)
      })
    ])
  } finally {
    clearTimeout(deadline)
  }
}

const RESET_OUTCOME_ACTION = {
  allowed: 'reset_outcome_allowed',
  denied: 'reset_outcome_still_denied',
  unknown: 'reset_outcome_unknown'
} as const satisfies Record<FreshDaemonAccess, EventProps<'daemon_folder_access_notice'>['action']>

function emitResetOutcome(cwdClass: DaemonPtyCwdClass, access: FreshDaemonAccess): void {
  try {
    track('daemon_folder_access_notice', {
      action: RESET_OUTCOME_ACTION[access],
      cwd_class: cwdClass
    })
  } catch {
    // Telemetry failure must not change the reset outcome.
  }
}

export async function resetFolderAccessForDaemon(
  identity: DaemonEndpointIdentity | null
): Promise<DaemonFolderAccessResetResult> {
  if (process.platform !== 'darwin') {
    return { outcome: 'unsupported' }
  }
  const target = getDaemonFolderAccessTarget(identity)
  if (!target || !isMacTccFolderClass(target.cwdClass)) {
    return { outcome: 'unsupported' }
  }
  const bundleId = await readMacosBundleId(runningAppBundlePath())
  if (bundleId === null) {
    return { outcome: 'unsupported' }
  }
  if (!(await resetMacosTccPermission(TCC_SERVICE_BY_CWD_CLASS[target.cwdClass], bundleId)).ok) {
    return { outcome: 'reset_failed' }
  }
  const prompted = await promptByReadingFolder(target.canonicalPath)
  // An unanswered prompt cannot yield a post-reset access verdict.
  if (prompted) {
    await refreshDaemonFolderAccessProbe(identity, { force: true })
  }
  const mismatch = getDaemonFolderAccessMismatch(identity)
  // The stored verdict predates an unanswered reset, so both event and dialog must report unknown.
  const access = prompted ? (mismatch?.freshDaemonAccess ?? 'unknown') : 'unknown'
  emitResetOutcome(target.cwdClass, access)
  return { outcome: 'probed', mismatch: mismatch && { ...mismatch, freshDaemonAccess: access } }
}
