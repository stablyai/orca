import type {
  ZotzAutostartRemovalResult,
  ZotzNodeSetupResult,
  ZotzNodeSetupStep,
  ZotzTailscaleStatus
} from '../../../shared/zotz/zotz-node-setup-contract'

export type ZotzNodeApi = {
  getTailscaleStatus: () => Promise<ZotzTailscaleStatus>
  runServerSetup: () => Promise<ZotzNodeSetupResult>
  onSetupProgress: (callback: (steps: ZotzNodeSetupStep[]) => void) => () => void
  removeAutostart: () => Promise<ZotzAutostartRemovalResult>
}
