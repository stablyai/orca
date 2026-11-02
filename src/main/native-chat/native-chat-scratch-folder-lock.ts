// Orders an Orca save into a chat's scratch folder against the sweep expiring that folder. Expiry
// renames the folder aside under this lock, so a save either lands first (its candidate mark keeps
// the folder) or runs after and fails on the missing folder, leaving the draft unsaved. A save
// never takes the session lane, so it never waits for an agent start.

import { relative } from 'node:path'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import {
  isNativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

type ExpiryCandidate = { current: boolean }

const folderQueues = new Map<string, Promise<void>>()
// The age scan runs outside the lock, so a save that settles after it starts makes it stale.
// A set per folder: each runtime install runs its own sweep, so two can scan one folder at once.
const expiryCandidates = new Map<string, Set<ExpiryCandidate>>()

/** The scratch folder `filePath` lies inside, or null for any other path. */
function scratchFolderNameOf(stateDirectory: string, filePath: string): string | null {
  const segments = relative(nativeChatScratchRootFor(stateDirectory), filePath).split(/[\\/]/)
  return segments.length > 1 && isNativeChatScratchFolderName(segments[0]) ? segments[0] : null
}

/** Runs an Orca save; one into a chat scratch folder holds that folder's lock. */
export function runNativeChatScratchSave<T>(
  stateDirectory: string,
  filePath: string,
  save: () => Promise<T>
): Promise<T> {
  const folderName = scratchFolderNameOf(stateDirectory, filePath)
  if (!folderName) {
    return save()
  }
  return runKeyedSerializedOperation(folderQueues, folderName, async () => {
    try {
      return await save()
    } finally {
      for (const candidate of expiryCandidates.get(folderName) ?? []) {
        candidate.current = false
      }
    }
  })
}

export function runUnderNativeChatScratchFolderLock<T>(
  folderName: string,
  task: () => Promise<T>
): Promise<T> {
  return runKeyedSerializedOperation(folderQueues, folderName, task)
}

/** Registered before the sweep's age scan; the scan stays usable only while `isCurrent`. */
export function trackNativeChatScratchExpiryCandidate(folderName: string): {
  isCurrent: () => boolean
  dispose: () => void
} {
  const candidate: ExpiryCandidate = { current: true }
  const candidates = expiryCandidates.get(folderName) ?? new Set<ExpiryCandidate>()
  candidates.add(candidate)
  expiryCandidates.set(folderName, candidates)
  return {
    isCurrent: () => candidate.current,
    dispose: () => {
      candidates.delete(candidate)
      if (candidates.size === 0) {
        expiryCandidates.delete(folderName)
      }
    }
  }
}
