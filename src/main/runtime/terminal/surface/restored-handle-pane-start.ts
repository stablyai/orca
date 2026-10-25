// Send/wait/read on an unstarted restored pane shares main's starter, then acts on its terminal.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../wait/terminal-interactive-wait'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'
import { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } from '../../orca-runtime-core'
import type { RestoredPane } from '../recovery/restored-pane-start'

export abstract class OrcaRuntimeWithRestoredHandlePaneStart extends OrcaRuntimeWithGetTerminalInteractiveWait {
  /** Return null synchronously unless main must start this saved pane; use the started terminal's handle until binding/adoption catches up. */
  startRestoredHandlePane(
    handle: string,
    bounds: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<string> | null {
    const pane = this.restoredPaneToStart(handle)
    if (!pane) {
      return null
    }
    return withinCallerBounds(this.ensureRestoredPaneStarted(pane), {
      ...bounds,
      startTimeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
    }).then((started) => {
      const pty = started === null ? undefined : this.ptysById.get(started.id)
      if (!pty) {
        throw new Error('terminal_not_found')
      }
      return this.issuePtyHandle(pty)
    })
  }

  private restoredPaneToStart(handle: string): RestoredPane | null {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || this.getLivePtyForHandle(handle)) {
      return null
    }
    let leaf
    try {
      leaf = this.getLiveLeafForHandle(handle).leaf
    } catch {
      // The caller's own path answers a stale, not-ready or structured-worker handle as before.
      return null
    }
    return !leaf.ptyId && startedMainTerminalSurfaces(this)?.ownsWorkspace(leaf.worktreeId)
      ? { worktreeId: leaf.worktreeId, tabId: leaf.tabId, leafId: leaf.leafId }
      : null
  }
}

/** Bound this caller by abort/deadline/start cap; the shared start continues for other callers. */
function withinCallerBounds<T>(
  start: Promise<T>,
  {
    signal,
    timeoutMs,
    startTimeoutMs
  }: { signal?: AbortSignal; timeoutMs?: number; startTimeoutMs: number }
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error('request_aborted'))
  }
  const callerFirst = !!timeoutMs && timeoutMs > 0 && timeoutMs <= startTimeoutMs
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      finish()
    }
    const abort = (): void => settle(() => reject(new Error('request_aborted')))
    const timer = setTimeout(
      () => settle(() => reject(new Error(callerFirst ? 'timeout' : 'runtime_timeout'))),
      callerFirst ? timeoutMs : startTimeoutMs
    )
    signal?.addEventListener('abort', abort, { once: true })
    start.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    )
  })
}
