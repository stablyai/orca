// Applying each records frame must equal a fresh partition projection; tests check every frame and dev builds log Store-write mismatches (workspace-layout-frame-observer.ts).

import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { applyWorkspaceLayoutRecordChange } from '../../shared/workspace-layout/workspace-layout-records'
import type { LayoutFrameObservation } from './workspace-layout-frame-observer'

/** Empty when the frame holds exactly what changed. */
export function layoutFrameModelErrors({ frame, before, fresh }: LayoutFrameObservation): string[] {
  const errors: string[] = []
  const applied = new Map(before)
  for (const change of frame.workspaces) {
    try {
      const next = applyWorkspaceLayoutRecordChange(applied.get(change.key), change)
      if (next) {
        applied.set(change.key, next)
      } else {
        applied.delete(change.key)
      }
    } catch (error) {
      errors.push(`frame ${frame.seq}: ${change.key} does not apply: ${String(error)}`)
    }
  }
  const expected = fresh()
  for (const key of new Set([...applied.keys(), ...expected.keys()])) {
    const shown = applied.get(key)
    const published = expected.get(key)
    if (!shown || !published) {
      errors.push(
        `frame ${frame.seq}: ${key} is ${shown ? 'shown but not published' : 'published but not shown'}`
      )
    } else if (stableJson(shown) !== stableJson(published)) {
      errors.push(`frame ${frame.seq}: ${key} differs from a fresh projection`)
    }
  }
  return errors
}

let mismatchLogged = false

/** The dev build's check: logs the first mismatching frame only; a title-only frame is skipped. */
export function logLayoutFrameModelErrors(observation: LayoutFrameObservation): void {
  if (mismatchLogged || observation.titlesOnly) {
    return
  }
  const errors = layoutFrameModelErrors(observation)
  if (errors.length > 0) {
    mismatchLogged = true
    console.warn('[workspace-layout] a layout frame does not match main’s model:', errors)
  }
}
