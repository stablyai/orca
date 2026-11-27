import type { WebFrameMain } from 'electron'
import type {
  GrabExecutionResult,
  GrabOverlayAction,
  GrabPickOperation
} from '../../../shared/browser/element-grab/grab-execution-protocol'
import type { GrabDocumentScope } from './grab-document-scope'

export type GrabExecutionOptions = {
  worldId?: number
  background?: boolean
  loadedOnly?: boolean
  signal?: AbortSignal
  selection?: boolean
  scope?: GrabDocumentScope
  clean?: boolean
  overlayControl?: boolean
  capturePick?: 'held' | 'hover'
  pick?: { selectionId: string; operation: GrabPickOperation; captureId?: string }
  overlayAction?: GrabOverlayAction
}

export type GrabExecutionTask = {
  id: string
  code: string
  options: GrabExecutionOptions
  frame: WebFrameMain | null
  documentId: string | null
  started: boolean
  live: boolean
  timer?: ReturnType<typeof setTimeout>
  resolve: (result: GrabExecutionResult) => void
  stopWaiting: () => void
}
