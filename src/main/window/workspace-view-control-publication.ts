import type { WorkspaceViewController } from '../../shared/workspace-view-control'

type Snapshot = Record<string, WorkspaceViewController>
export class WorkspaceViewControlPublication {
  private published: Snapshot = {}

  async publish(
    next: Snapshot,
    live: Set<number>,
    send: (id: number, snapshot: Snapshot) => Promise<void>
  ): Promise<void> {
    const snapshot = { ...next }
    const revocations = new Map<number, string[]>()
    for (const [key, previous] of Object.entries(this.published)) {
      if (previous.windowId === next[key]?.windowId && previous.viewId === next[key]?.viewId) {
        continue
      }
      if (!live.has(previous.windowId)) {
        continue
      }
      const keys = revocations.get(previous.windowId) ?? []
      keys.push(key)
      revocations.set(previous.windowId, keys)
    }
    await Promise.all(
      [...revocations].map(async ([id, keys]) => {
        try {
          await send(id, {
            ...this.published,
            ...Object.fromEntries(keys.map((key) => [key, { windowId: 0, viewId: '' }]))
          })
        } catch {
          for (const key of keys) {
            snapshot[key] = this.published[key]
          }
        }
      })
    )
    this.published = snapshot
    await Promise.allSettled([...live].map((id) => send(id, snapshot)))
  }
}
