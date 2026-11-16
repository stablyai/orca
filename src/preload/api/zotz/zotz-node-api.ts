import type {
  ZotzAutostartRemovalResult,
  ZotzNodeSetupResult,
  ZotzNodeSetupStep
} from '../../../shared/zotz/zotz-node-setup-contract'

export type ZotzNodeApi = {
  runServerSetup: () => Promise<ZotzNodeSetupResult>
  onSetupProgress: (callback: (steps: ZotzNodeSetupStep[]) => void) => () => void
  removeAutostart: () => Promise<ZotzAutostartRemovalResult>
}
