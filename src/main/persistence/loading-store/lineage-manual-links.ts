import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { ManualPullRequestLink } from '../../../shared/lineage-discovery-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type LineageManualLinkRuntime = Pick<StoreRuntimeState, 'state'>

const lineageManualLinkPersistenceContext = Symbol('LineageManualLinkPersistence')
type LineageManualLinkPersistenceContext = {
  runtime: LineageManualLinkRuntime
  scheduling: WriteSchedulingOperations
}

export class LineageManualLinkPersistence {
  readonly [lineageManualLinkPersistenceContext]: LineageManualLinkPersistenceContext

  constructor(runtime: LineageManualLinkRuntime, scheduling: WriteSchedulingOperations) {
    this[lineageManualLinkPersistenceContext] = { runtime, scheduling }
  }

  getLineageManualLinks(parentKey: WorkspaceKey): ManualPullRequestLink[] {
    const { state } = this[lineageManualLinkPersistenceContext].runtime
    return state.lineageManualLinksByParentKey?.[parentKey] ?? []
  }

  setLineageManualLinks(parentKey: WorkspaceKey, links: ManualPullRequestLink[]): void {
    const { runtime, scheduling } = this[lineageManualLinkPersistenceContext]
    const next = { ...runtime.state.lineageManualLinksByParentKey }
    if (links.length === 0) {
      delete next[parentKey]
    } else {
      next[parentKey] = links
    }
    runtime.state.lineageManualLinksByParentKey = next
    scheduleSave(scheduling)
  }
}

export function installLineageManualLinkPersistenceContext(
  target: LineageManualLinkPersistence,
  source: LineageManualLinkPersistence
): void {
  Object.defineProperty(target, lineageManualLinkPersistenceContext, {
    value: source[lineageManualLinkPersistenceContext]
  })
}
