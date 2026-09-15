import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { operationModuleLoader, type OperationMutation } from './operation-module-loader'
import type { MountOptions } from './mounted-operation-module'
import type { MountAdapter } from './recording-scenario'

/**
 * The mount table one recording runs against: every registered domain module, merged. Nothing is
 * mounted here, because an adapter defined in this file would be pinned by `recorderSha256` on
 * every golden rather than by `adapterSha256` on the goldens that mount it.
 *
 * Each module gets its own loader, carrying its own exposures. One recording mounts one adapter, so
 * a golden is only ever influenced by the exposures its own module declares — which is what lets
 * `adapterSha256` pin them instead of every golden's `recorderSha256`.
 */
export function pilotMountAdapters(
  root: string,
  options: MountOptions & { mutation?: OperationMutation } = {}
) {
  const loaders = MOUNTED_OPERATION_MODULES.map((module) => ({
    module,
    modules: operationModuleLoader(root, options.mutation, module.exposes ?? [])
  }))

  const adapters: Record<string, MountAdapter> = {}

  for (const { module, modules } of loaders) {
    for (const [operation, adapter] of Object.entries(module.mounts(modules, options))) {
      if (operation in adapters) {
        throw new Error(`Two adapter modules mount ${operation}`)
      }

      adapters[operation] = adapter
    }
  }

  return {
    adapters,
    assertMutationApplied: () => {
      const applied = loaders.reduce((total, { modules }) => total + modules.mutationsApplied(), 0)

      if (options.mutation && applied !== 1) {
        throw new Error(`Expected one mutation, applied ${applied}`)
      }
    }
  }
}
