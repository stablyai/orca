// A workspace teammate's layout.subscribe: frames for the agent's workspaces alone, judged in order
// after any re-read of the set they wait on (so a new worker's first layout arrives, and a shown one's
// removal too), with the agent's home shown per person: only their own chats' tabs.
import type { RpcContext } from '../../runtime/rpc/core'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/published-layout/workspace-layout-published'
import type {
  WorkspaceLayoutSnapshotEntry,
  WorkspaceLayoutStreamEvent
} from '../../../shared/workspace-layout/published-layout/workspace-layout-stream-frames'
import {
  applyWorkspaceLayoutRecordChange,
  type WorkspaceLayoutRecordChange
} from '../../../shared/workspace-layout/published-layout/workspace-layout-records'
import { openTracker } from './agent-workspace-tracker'
import { botShareOwnsSession } from './bot-share-chats'

export async function openTeammateLayoutStream(
  context: Pick<RpcContext, 'callerScope' | 'runtime' | 'signal'>
) {
  const tracker = await openTracker(context)
  if (!tracker) {
    return null
  }
  const { runtime } = context
  const home = tracker.current().homeKey
  const shown = new Set<string>()
  // The home's whole layout, so each of its changes goes out as the teammate's own layout.
  let homeLayout: PublishedWorkspaceLayout | undefined
  const personal = (layout: PublishedWorkspaceLayout) =>
    personalHomeLayout(layout, (sessionId) =>
      botShareOwnsSession(runtime, tracker.scope, sessionId)
    )
  const listed = (key: string) => tracker.has(key) || shown.has(key)
  const entry = (key: string, layout: PublishedWorkspaceLayout) => {
    shown.add(key)
    if (key !== home) {
      return layout
    }
    homeLayout = layout
    return personal(layout)
  }
  const change = (next: WorkspaceLayoutRecordChange): WorkspaceLayoutRecordChange | null => {
    if (!listed(next.key)) {
      return null
    }
    if (next.change === 'removed') {
      shown.delete(next.key)
      homeLayout = next.key === home ? undefined : homeLayout
      return next
    }
    if (next.key !== home) {
      shown.add(next.key)
      return next
    }
    try {
      const whole = applyWorkspaceLayoutRecordChange(homeLayout, next)
      return whole ? { key: next.key, change: 'layout', layout: entry(next.key, whole) } : null
    } catch {
      // A change the stream can't place: the client re-reads on the next whole layout.
      return null
    }
  }
  return {
    snapshot: (entries: readonly WorkspaceLayoutSnapshotEntry[]): WorkspaceLayoutSnapshotEntry[] =>
      entries
        .filter((snapshot) => tracker.has(snapshot.key))
        .map((snapshot) => ({ key: snapshot.key, layout: entry(snapshot.key, snapshot.layout) })),
    event: (event: WorkspaceLayoutStreamEvent, emit: (event: WorkspaceLayoutStreamEvent) => void) =>
      tracker.after(() => {
        if (event.type === 'records') {
          // Every records frame goes out, so the reader's position stays gapless.
          emit({ ...event, workspaces: event.workspaces.flatMap((next) => change(next) ?? []) })
        } else if (event.type === 'removed' && shown.has(event.key)) {
          shown.delete(event.key)
          emit(event)
        } else if (event.type === 'workspace' && listed(event.key)) {
          emit({ ...event, layout: entry(event.key, event.layout) })
        }
      }),
    dispose: () => tracker.dispose()
  }
}

/** The home as one person sees it: their own chats' tabs only. */
export function personalHomeLayout(
  layout: PublishedWorkspaceLayout,
  owns: (sessionId: string) => boolean
): PublishedWorkspaceLayout {
  const tabs = layout.tabs.filter((tab) => tab.kind === 'agent-session' && owns(tab.entityId))
  const kept = new Set(tabs.map((tab) => tab.id))
  return {
    ...layout,
    tabs,
    groups: layout.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => kept.has(id))
    })),
    editorFiles: [],
    browserTabs: []
  }
}
