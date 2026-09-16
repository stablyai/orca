import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

const OPEN_WITH_RECENT_APPLICATIONS_LIMIT = 5

type OpenWithRecentApplicationRuntime = Pick<StoreRuntimeState, 'state' | 'writesFrozen'>

const openWithRecentApplicationPersistenceContext = Symbol('OpenWithRecentApplicationPersistence')
type OpenWithRecentApplicationPersistenceContext = {
  runtime: OpenWithRecentApplicationRuntime
  scheduling: WriteSchedulingOperations
}

/** Per-extension Open With recency; ids only affect ranking, never what launches. */
export class OpenWithRecentApplicationPersistence {
  readonly [openWithRecentApplicationPersistenceContext]: OpenWithRecentApplicationPersistenceContext

  constructor(runtime: OpenWithRecentApplicationRuntime, scheduling: WriteSchedulingOperations) {
    this[openWithRecentApplicationPersistenceContext] = { runtime, scheduling }
  }

  getOpenWithRecentApplicationIds(extension: string): string[] {
    const key = extension.trim().toLowerCase()
    if (!key) {
      return []
    }
    const byExtension =
      this[openWithRecentApplicationPersistenceContext].runtime.state
        .openWithRecentApplicationsByExtension
    return [...(byExtension?.[key] ?? [])]
  }

  recordOpenWithApplicationLaunch(extension: string, applicationId: string): void {
    const { runtime, scheduling } = this[openWithRecentApplicationPersistenceContext]
    const key = extension.trim().toLowerCase()
    if (!key || !applicationId || runtime.writesFrozen) {
      return
    }
    const byExtension = (runtime.state.openWithRecentApplicationsByExtension ??= {})
    byExtension[key] = [
      applicationId,
      ...(byExtension[key] ?? []).filter((id) => id !== applicationId)
    ].slice(0, OPEN_WITH_RECENT_APPLICATIONS_LIMIT)
    scheduleSave(scheduling)
  }
}

export function installOpenWithRecentApplicationPersistenceContext(
  target: object,
  source: OpenWithRecentApplicationPersistence
): void {
  Object.defineProperty(target, openWithRecentApplicationPersistenceContext, {
    value: source[openWithRecentApplicationPersistenceContext]
  })
}
