// Test hooks on main's layout stream. `installLayoutFrameModelCheck` (installed by the operation-frame
// tests) checks every records frame against a fresh projection and freezes each partition read.
// Dev builds log the frame check on structural frames; release builds run neither.

import { logLayoutFrameModelErrors } from './workspace-layout-frame-model-check'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutRecordsFrame } from '../../shared/workspace-layout/workspace-layout-stream-frames'

export type LayoutFrameObservation = {
  frame: WorkspaceLayoutRecordsFrame
  /** What subscribers held before the frame. */
  before: ReadonlyMap<string, PublishedWorkspaceLayout>
  /** Every workspace as a projection from scratch publishes it now. */
  fresh: () => ReadonlyMap<string, PublishedWorkspaceLayout>
  /** Only live titles changed: no Store write, so no projection to check. */
  titlesOnly: boolean
}

export type LayoutFrameObserver = (observation: LayoutFrameObservation) => void

let observer: LayoutFrameObserver | null = null

// Why NODE_ENV: electron-vite sets it to 'development' only for a dev build; tests set 'test'.
const DEV_BUILD_CHECK: LayoutFrameObserver | null =
  process.env.NODE_ENV === 'development' ? logLayoutFrameModelErrors : null

/** Null removes the observer. */
export function observeWorkspaceLayoutFrames(next: LayoutFrameObserver | null): void {
  observer = next
}

export function workspaceLayoutFrameObserver(): LayoutFrameObserver | null {
  return observer ?? DEV_BUILD_CHECK
}

let partitionReadObserver: ((loaded: LoadedWorkspaceLayout) => void) | null = null

/** Tests: sees each partition model handed to a reader, so a mutating reader fails. Null removes it. */
export function observeWorkspaceLayoutPartitionReads(
  next: ((loaded: LoadedWorkspaceLayout) => void) | null
): void {
  partitionReadObserver = next
}

export function workspaceLayoutPartitionReadObserver():
  | ((loaded: LoadedWorkspaceLayout) => void)
  | null {
  return partitionReadObserver
}
