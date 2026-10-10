/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './orca-runtime-collect-mobile-visible-graph-changed-worktrees'

// Why bounded: an old client is withheld until the renderer publishes (it would prune tabs from
// an unpublished list), but a host whose graph never publishes must refuse, not hang the call.
export const SESSION_TABS_INVENTORY_PUBLICATION_WAIT_MS = 30_000

export class OrcaRuntimeWithWaitForSessionTabsInventoryPublication extends OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees {
  protected waitForSessionTabsInventoryPublication(
    signal?: AbortSignal,
    timeoutMs = SESSION_TABS_INVENTORY_PUBLICATION_WAIT_MS
  ): Promise<void> {
    if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('runtime_unavailable'))
      }, timeoutMs)
      timer.unref?.()
      const cleanup = (): void => {
        clearTimeout(timer)
        this.sessionTabsInventoryWaiters.delete(onPublished)
        signal?.removeEventListener('abort', onAbort)
      }
      const onPublished = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      this.sessionTabsInventoryWaiters.add(onPublished)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
      } else if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
        onPublished()
      }
    })
  }

  protected getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return this.graphStatus === 'ready' &&
      this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch
      ? this.rendererGraphEpoch
      : null
  }

  protected markSessionTabsInventoryPublished(): void {
    if (this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch) {
      return
    }
    this.sessionTabsInventoryPublicationEpoch = this.rendererGraphEpoch
    for (const publish of [...this.sessionTabsInventoryWaiters]) {
      publish()
    }
  }
}
