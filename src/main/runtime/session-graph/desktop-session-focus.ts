import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeSyncWindowGraph } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isNativeSessionFocusId } from '../../../shared/workspace-layout/selected-native-session-id'

type Publication = { windowId: number; generation: string; ids: ReadonlyMap<string, string | null> }
export class DesktopSessionFocus {
  private publication: Publication | undefined
  private readonly listeners = new Set<() => void>()

  read(
    worktreeId: string,
    current: { ready: boolean; windowId: number | null; generation: string | null | undefined }
  ): string | null | undefined {
    const focus = this.publication
    return current.ready &&
      focus?.windowId === current.windowId &&
      focus?.generation === current.generation
      ? focus.ids.get(worktreeId)
      : undefined
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  publish(
    windowId: number,
    generation: string | null | undefined,
    ids: RuntimeSyncWindowGraph['activeSessionIdsByWorkspace']
  ): void {
    const previous = this.publication
    const next =
      windowId !== HEADLESS_RUNTIME_WINDOW_ID && typeof generation === 'string' && ids
        ? {
            windowId,
            generation,
            ids: new Map(
              Object.entries(ids).filter(([, id]) => id === null || isNativeSessionFocusId(id))
            )
          }
        : undefined
    this.publication = next
    if (
      previous?.windowId !== next?.windowId ||
      previous?.generation !== next?.generation ||
      JSON.stringify([...(previous?.ids ?? [])]) !== JSON.stringify([...(next?.ids ?? [])])
    ) {
      this.notify()
    }
  }
}
