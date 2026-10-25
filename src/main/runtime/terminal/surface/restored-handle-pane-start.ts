// Layout-owner builds: a CLI or orchestration send, wait or read on a handle whose pane main holds
// with no terminal yet (a saved pane not started since restore) starts it through main's one
// starter, then acts on the started terminal.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../wait/terminal-interactive-wait'
import { startedMainTerminalSurfaces } from './main-terminal-surfaces'
import { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } from '../../orca-runtime-core'
import type { RestoredPane } from '../recovery/restored-pane-start'

export abstract class OrcaRuntimeWithRestoredHandlePaneStart extends OrcaRuntimeWithGetTerminalInteractiveWait {
  /**
   * Null unless the handle names a saved pane main holds with no terminal yet; then the started
   * terminal's own handle, to act on until main's layout binds the pane and the caller's handle
   * adopts the terminal (adoptFirstPtyForLeafHandle). Null keeps the caller synchronous.
   */
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

/**
 * The start, or the first of: the caller's abort, the caller's deadline (`timeout`), or the start's
 * own cap (`runtime_timeout`, the pending-terminal create bound), so no caller waits on a start
 * forever. The shared start itself runs on.
 */
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
