import {
  UPDATER_INSTALL_COMMITTED_CHANNEL,
  UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL
} from '../shared/updater-install-events'

export type InstallCommitmentIpc = {
  on: (channel: string, listener: (event: unknown, committed: boolean) => void) => unknown
  sendSync: (channel: string) => unknown
}

/**
 * Buffers main's install commitment for this document.
 *
 * Runs at preload time, before any document script, because a renderer that
 * subscribed later — from a React effect, say — could miss a broadcast and never
 * recover it: the async round trip goes unanswered while the Linux package install
 * blocks main inside spawnSync. The returned reader is live rather than a snapshot,
 * so a commitment landing after this call is still seen by the next chunk failure.
 */
export function createInstallCommitmentReader(ipc: InstallCommitmentIpc): () => boolean {
  let committed = false
  let mainHasSpoken = false

  // Subscribe before sampling: a `true` arriving while the sample is in flight must
  // not be overwritten by the older `false` that sample returns.
  ipc.on(UPDATER_INSTALL_COMMITTED_CHANNEL, (_event, next) => {
    mainHasSpoken = true
    committed = next === true
  })

  try {
    const sampled = ipc.sendSync(UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL) === true
    if (!mainHasSpoken) {
      committed = sampled
    }
  } catch {
    // An unanswered probe must never stop a window loading, and must never claim an
    // install: guessing true would disable ordinary chunk recovery for this document.
    committed = false
  }

  return () => committed
}
