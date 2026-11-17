import { ipcRenderer } from 'electron'
import type { ZotzNodeSetupStep } from '../../../shared/zotz/zotz-node-setup-contract'
import { shouldAutoShowZotzMachineModeWizard } from '../../../shared/zotz/zotz-machine-mode'
import type { PreloadApi } from '../../api-types'

export const zotzNodeApi = {
  autoShowFirstRun: shouldAutoShowZotzMachineModeWizard({
    e2eUserDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
    devBuild: import.meta.env.DEV,
    // Upstream's DEV_SHOW_FIRST_RUN_EDUCATION_ENV override for dev onboarding.
    showFirstRunEducation: process.env.ORCA_DEV_SHOW_FIRST_RUN_EDUCATION
  }),
  runServerSetup: () => ipcRenderer.invoke('zotzNode:runServerSetup'),
  onSetupProgress: (callback: (steps: ZotzNodeSetupStep[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, steps: ZotzNodeSetupStep[]): void =>
      callback(steps)
    ipcRenderer.on('zotzNode:setupProgress', listener)
    return () => ipcRenderer.removeListener('zotzNode:setupProgress', listener)
  },
  removeAutostart: () => ipcRenderer.invoke('zotzNode:removeAutostart')
} satisfies PreloadApi['zotzNode']
