import type { WebContents } from 'electron'
import { isWslPath } from '../../../wsl/filesystem/unc-path-access'
import type { FsWatchPausedPayload } from '../../../../shared/file-watch/filesystem-change-event'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'

// Why derived, not stored: every input already has an owner, so a missed clear cannot strand "paused".
const lastPublished = new Map<string, { rootPath: string; paused: boolean }>()
let localDeliveryStalled = false
// Roots dropped by a non-fuse watcher error: nothing retries them until a renderer subscribes again.
const erroredRoots = new Set<string>()

function isLocalWatchPaused(rootKey: string): boolean {
  const state = watcherLifecycleState
  if (state.pendingLocalCapacityRetries.has(rootKey) || state.unwatchableRoots.has(rootKey)) {
    return true
  }
  const root = state.watchedRoots.get(rootKey)
  if (!root && erroredRoots.has(rootKey)) {
    return true
  }
  // Only Parcel roots share the stalled child; WSL roots poll inside the distro.
  return localDeliveryStalled && root !== undefined && !isWslPath(root.rootPath)
}

function rootListeners(rootKey: string): Map<number, WebContents> {
  const state = watcherLifecycleState
  const listeners = new Map<number, WebContents>()
  // No in-flight install listeners: publishing waits for installs to settle.
  for (const source of [
    state.watchedRoots.get(rootKey)?.listeners,
    state.pendingLocalCapacityRetries.get(rootKey)?.listeners
  ]) {
    for (const [id, listener] of source ?? []) {
      listeners.set(id, listener)
    }
  }
  return listeners
}

function send(listener: WebContents, payload: FsWatchPausedPayload): void {
  if (!listener.isDestroyed()) {
    listener.send('fs:watchPaused', payload)
  }
}

/** Push the root's paused state to its listeners when it changed. An install in flight keeps the last state until it settles. */
/** Returns the ids of the listeners it told, so a caller can avoid telling one twice. */
export function publishLocalWatchPause(rootKey: string, rootPath?: string): Set<number> {
  const told = new Set<number>()
  if (watcherLifecycleState.inFlightLocalInstalls.has(rootKey)) {
    return told
  }
  // A reinstalled root supersedes the error that dropped its predecessor.
  if (watcherLifecycleState.watchedRoots.has(rootKey)) {
    erroredRoots.delete(rootKey)
  }
  const previous = lastPublished.get(rootKey)
  const path = rootPath ?? previous?.rootPath
  if (path === undefined) {
    return told
  }
  const paused = isLocalWatchPaused(rootKey)
  if ((previous?.paused ?? false) === paused) {
    return told
  }
  if (paused) {
    lastPublished.set(rootKey, { rootPath: path, paused })
  } else {
    lastPublished.delete(rootKey)
  }
  for (const listener of rootListeners(rootKey).values()) {
    send(listener, { worktreePath: path, paused })
    told.add(listener.id)
  }
  return told
}

/** A (re)subscribing renderer, e.g. after a window reload, learns the root's current state. */
export function sendLocalWatchPauseTo(
  rootKey: string,
  rootPath: string,
  sender: WebContents
): void {
  const told = publishLocalWatchPause(rootKey, rootPath)
  // Send "resumed" too: this window may still hold a pause from a root it was dropped from.
  if (!told.has(sender.id)) {
    send(sender, { worktreePath: rootPath, paused: lastPublished.get(rootKey)?.paused ?? false })
  }
}

/** The root's watch failed and was dropped; its listeners keep no auto-reload until they resubscribe. */
export function noteLocalWatchErrored(
  rootKey: string,
  rootPath: string,
  listeners: Map<number, WebContents>
): void {
  erroredRoots.add(rootKey)
  const told = publishLocalWatchPause(rootKey, rootPath)
  // The dropped root's listeners are no longer reachable through lifecycle state.
  if (lastPublished.get(rootKey)?.paused) {
    for (const listener of listeners.values()) {
      if (!told.has(listener.id)) {
        send(listener, { worktreePath: rootPath, paused: true })
      }
    }
  }
}

export function setLocalWatcherDeliveryStalled(stalled: boolean): void {
  if (localDeliveryStalled === stalled) {
    return
  }
  localDeliveryStalled = stalled
  for (const [rootKey, root] of watcherLifecycleState.watchedRoots) {
    publishLocalWatchPause(rootKey, root.rootPath)
  }
}

export function resetLocalWatchPauseState(): void {
  lastPublished.clear()
  erroredRoots.clear()
  localDeliveryStalled = false
}
