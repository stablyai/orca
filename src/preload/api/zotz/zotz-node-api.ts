import type {
  ZotzAutostartRemovalResult,
  ZotzNodeSetupProgress,
  ZotzNodeSetupResult
} from '../../../shared/zotz/zotz-node-setup-contract'

export type ZotzNodeApi = {
  /** False for e2e and dev launches, which keep the old first-run behavior. */
  autoShowFirstRun: boolean
  runServerSetup: () => Promise<ZotzNodeSetupResult>
  onSetupProgress: (callback: (progress: ZotzNodeSetupProgress) => void) => () => void
  removeAutostart: () => Promise<ZotzAutostartRemovalResult>
}
