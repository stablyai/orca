import type {
  OrcaUninstallFinishAction,
  OrcaUninstallPlan,
  OrcaUninstallRunStepArgs
} from '../../../shared/uninstall/orca-uninstall-types'

export type OrcaUninstallApi = {
  /** Read-only: what the cleanup would change on this machine. */
  getPlan: () => Promise<OrcaUninstallPlan>
  /** Runs one step and returns the whole plan with that step's entries updated. */
  runStep: (args: OrcaUninstallRunStepArgs) => Promise<OrcaUninstallPlan>
  finish: (action: OrcaUninstallFinishAction) => Promise<void>
}
