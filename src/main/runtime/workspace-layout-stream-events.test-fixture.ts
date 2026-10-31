// Normalize records frames into per-workspace whole-layout events so both layout ownership modes share assertions.

import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import { applyWorkspaceLayoutRecordChange } from '../../shared/workspace-layout/workspace-layout-records'
import type {
  WorkspaceLayoutEvent,
  WorkspaceLayoutStreamEvent
} from '../../shared/workspace-layout/workspace-layout-stream-frames'

export type LayoutEventCollector = {
  /** One per workspace changed, in frame order. */
  events: WorkspaceLayoutEvent[]
  frames: WorkspaceLayoutStreamEvent[]
  /** What a reader applying every frame to the snapshot holds now. */
  layouts: Map<string, PublishedWorkspaceLayout>
  listener: (event: WorkspaceLayoutStreamEvent) => void
  seed: (snapshot: { key: string; layout: PublishedWorkspaceLayout }[]) => void
}

export function collectLayoutEvents(): LayoutEventCollector {
  const collector: LayoutEventCollector = {
    events: [],
    frames: [],
    layouts: new Map(),
    seed: (snapshot) => {
      collector.layouts = new Map(snapshot.map(({ key, layout }) => [key, layout]))
    },
    listener: (event) => {
      collector.frames.push(event)
      if (event.type !== 'records') {
        collector.events.push(event)
        if (event.type === 'removed') {
          collector.layouts.delete(event.key)
        } else {
          collector.layouts.set(event.key, event.layout)
        }
        return
      }
      for (const change of event.workspaces) {
        const layout = applyWorkspaceLayoutRecordChange(collector.layouts.get(change.key), change)
        if (layout) {
          collector.layouts.set(change.key, layout)
          collector.events.push({ type: 'workspace', key: change.key, layout, seq: event.seq })
        } else {
          collector.layouts.delete(change.key)
          collector.events.push({ type: 'removed', key: change.key, seq: event.seq })
        }
      }
    }
  }
  return collector
}
