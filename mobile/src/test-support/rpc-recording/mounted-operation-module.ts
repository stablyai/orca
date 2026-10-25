import { operationModuleLoader, type OperationExposure } from './operation-module-loader'
import type { MountAdapter } from './recording-scenario'

// Reference mode loads archived product operations.
export type MountOptions = { reference?: boolean }

export type MountedOperationModule = {
  source: string
  /** Module-private product exports this domain's adapters drive, declared in `source`. */
  exposes?: readonly OperationExposure[]
  mounts: (
    modules: ReturnType<typeof operationModuleLoader>,
    options: MountOptions
  ) => Record<string, MountAdapter>
}
