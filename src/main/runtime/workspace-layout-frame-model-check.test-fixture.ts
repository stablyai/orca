// Check every layout frame and freeze partition models so accidental shared-model mutation throws.

import { layoutFrameModelErrors } from './workspace-layout-frame-model-check'
import {
  observeWorkspaceLayoutFrames,
  observeWorkspaceLayoutPartitionReads
} from './workspace-layout-frame-observer'

export function installLayoutFrameModelCheck(): {
  /** Every mismatch found, frame by frame. */
  failures: string[]
  /** How many frames were checked. */
  checked: () => number
  uninstall: () => void
} {
  const failures: string[] = []
  let checked = 0
  observeWorkspaceLayoutFrames((observation) => {
    checked += 1
    failures.push(...layoutFrameModelErrors(observation))
  })
  observeWorkspaceLayoutPartitionReads(deepFreeze)
  return {
    failures,
    checked: () => checked,
    uninstall: () => {
      observeWorkspaceLayoutFrames(null)
      observeWorkspaceLayoutPartitionReads(null)
    }
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const inner of Object.values(value)) {
    deepFreeze(inner)
  }
}
