import { OrcaRuntimeWithAttachWindow } from './session-graph-promotion'
import type {
  RuntimeRendererSyncWindowGraph,
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-session-contracts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'

export abstract class OrcaRuntimeWithAdmitWindowPublisher extends OrcaRuntimeWithAttachWindow {
  protected admitWindowPublisher(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): string | null | undefined {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.pendingHeadlessPromotionWindowId) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Accept late healthy graphs after failed promotion restores headless authority.
      this.attachWindow(windowId)
    }
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }
    const rendererGeneration =
      windowId === HEADLESS_RUNTIME_WINDOW_ID
        ? null
        : 'rendererGeneration' in graph && typeof graph.rendererGeneration === 'string'
          ? graph.rendererGeneration
          : undefined
    if (
      typeof rendererGeneration === 'string' &&
      rendererGeneration === this.rendererGeneration &&
      this.graphStatus !== 'ready'
    ) {
      throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
    }
    return rendererGeneration
  }
}
