import { ipcRenderer } from 'electron'
import type {
  WorktreeIconGenerationRequest,
  WorktreeIconGenerationCancellation,
  WorktreeIconGenerationResult
} from '../../shared/worktree/worktree-icon-generation'

export type WorktreeIconsApi = {
  generate: (args: WorktreeIconGenerationRequest) => Promise<WorktreeIconGenerationResult>
  cancel: (args: WorktreeIconGenerationCancellation) => Promise<void>
  clearCache: () => Promise<void>
}

export const worktreeIconsApi: WorktreeIconsApi = {
  generate: (args) => ipcRenderer.invoke('worktreeIcons:generate', args),
  cancel: (args) => ipcRenderer.invoke('worktreeIcons:cancel', args),
  clearCache: () => ipcRenderer.invoke('worktreeIcons:clearCache')
}
