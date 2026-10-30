// Tests check every records frame against a fresh projection and freeze partition reads; development logs structural frame mismatches, while release builds do neither.

import { logLayoutFrameModelErrors } from './workspace-layout-frame-model-check'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutRecordsFrame } from '../../shared/workspace-layout/workspace-layout-stream-frames'

export type LayoutFrameObservation = {
  frame: WorkspaceLayoutRecordsFrame
  /** Subscriber state before the frame. */
  before: ReadonlyMap<string, PublishedWorkspaceLayout>
  /** Fresh projection of all workspaces. */
  fresh: () => ReadonlyMap<string, PublishedWorkspaceLayout>
  /** Only live titles changed: no Store write, so no projection to check. */
  titlesOnly: boolean
}

export type LayoutFrameObserver = (observation: LayoutFrameObservation) => void

let observer: LayoutFrameObserver | null = null

// electron-vite marks dev builds as development; tests use test.
const DEV_BUILD_CHECK: LayoutFrameObserver | null =
  process.env.NODE_ENV === 'development' ? logLayoutFrameModelErrors : null

export function observeWorkspaceLayoutFrames(next: LayoutFrameObserver | null): void {
  observer = next
}

export function workspaceLayoutFrameObserver(): LayoutFrameObserver | null {
  return observer ?? DEV_BUILD_CHECK
}

let partitionReadObserver: ((loaded: LoadedWorkspaceLayout) => void) | null = null

/** Tests freeze partition reads to catch mutations; null removes the observer. */
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
