import { operationModuleLoader, type OperationExposure } from './operation-module-loader'
import type { MountAdapter } from './recording-scenario'

/** Reference mode wires an archived tree's operations instead of main's. */
export type MountOptions = { reference?: boolean }

/**
 * One domain's mount adapters and the `adapters/` file they live in. The file is what each golden
 * recorded through them pins, so a domain edit moves those goldens and no others.
 */
export type MountedOperationModule = {
  source: string
  /** Module-private product exports this domain's adapters drive. Declared in `source`, so pinned. */
  exposes?: readonly OperationExposure[]
  mounts: (
    modules: ReturnType<typeof operationModuleLoader>,
    options: MountOptions
  ) => Record<string, MountAdapter>
}
