import { ipcRenderer } from 'electron'
import type {
  WorktreeIconGenerationRequest,
  WorktreeIconGenerationResult
} from '../../shared/worktree/worktree-icon-generation'

export type WorktreeIconsApi = {
  generate: (args: WorktreeIconGenerationRequest) => Promise<WorktreeIconGenerationResult>
}

export const worktreeIconsApi: WorktreeIconsApi = {
  generate: (args) => ipcRenderer.invoke('worktreeIcons:generate', args)
}
