import { ipcRenderer } from 'electron'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../../shared/localhost-worktree-labels'
import type { PreloadApi } from '../api-types'

export const localhostWorktreeLabelsApi = {
  register: (args: LocalhostWorktreeLabelRoute): Promise<LocalhostWorktreeLabelResult> =>
    ipcRenderer.invoke('localhostWorktreeLabels:register', args)
} satisfies PreloadApi['localhostWorktreeLabels']
