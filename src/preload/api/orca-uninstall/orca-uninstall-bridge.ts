import { ipcRenderer } from 'electron'
import type {
  OrcaUninstallFinishAction,
  OrcaUninstallPlan,
  OrcaUninstallRunStepArgs
} from '../../../shared/uninstall/orca-uninstall-types'
import type { PreloadApi } from '../../api-types'

export const orcaUninstallApi = {
  getPlan: (): Promise<OrcaUninstallPlan> => ipcRenderer.invoke('orcaUninstall:getPlan'),
  runStep: (args: OrcaUninstallRunStepArgs): Promise<OrcaUninstallPlan> =>
    ipcRenderer.invoke('orcaUninstall:runStep', args),
  finish: (action: OrcaUninstallFinishAction): Promise<void> =>
    ipcRenderer.invoke('orcaUninstall:finish', action)
} satisfies PreloadApi['orcaUninstall']
