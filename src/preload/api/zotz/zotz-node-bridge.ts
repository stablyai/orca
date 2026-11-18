import { ipcRenderer } from 'electron'
import type { ZotzNodeSetupProgress } from '../../../shared/zotz/zotz-node-setup-contract'
import { shouldAutoShowZotzMachineModeWizard } from '../../../shared/zotz/zotz-machine-mode'
import type { PreloadApi } from '../../api-types'

export const zotzNodeApi = {
  autoShowFirstRun: shouldAutoShowZotzMachineModeWizard({
    e2eUserDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
    devBuild: import.meta.env.DEV,
    // Upstream's DEV_SHOW_FIRST_RUN_EDUCATION_ENV override for dev onboarding.
    showFirstRunEducation: process.env.ORCA_DEV_SHOW_FIRST_RUN_EDUCATION
  }),
  automatedLaunch: Boolean(process.env.ORCA_E2E_USER_DATA_DIR),
  runServerSetup: () => ipcRenderer.invoke('zotzNode:runServerSetup'),
  onSetupProgress: (callback: (progress: ZotzNodeSetupProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ZotzNodeSetupProgress): void =>
      callback(progress)
    ipcRenderer.on('zotzNode:setupProgress', listener)
    return () => ipcRenderer.removeListener('zotzNode:setupProgress', listener)
  },
  removeAutostart: () => ipcRenderer.invoke('zotzNode:removeAutostart')
} satisfies PreloadApi['zotzNode']
