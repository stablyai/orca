import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { declaredDeviceSubstitutes, type DeclaredDeviceState } from './declared-device-state'
import { operationModuleLoader, type OperationMutation } from './operation-module-loader'
import { bindSalvageObserver } from './salvage-observation'
import type { MountOptions } from './mounted-operation-module'
import type { MountAdapter } from './recording-scenario'

// Give each adapter module its own loader/exposures so unrelated domains cannot influence its golden.
export function pilotMountAdapters(
  root: string,
  options: MountOptions & { mutation?: OperationMutation; device?: DeclaredDeviceState } = {}
) {
  const device = declaredDeviceSubstitutes(options.device ?? {})
  const loaders = MOUNTED_OPERATION_MODULES.map((module) => ({
    module,
    modules: operationModuleLoader(root, options.mutation, module.exposes ?? [], device.substitutes)
  }))
  const adapters: Record<string, MountAdapter> = {}
  for (const { module, modules } of loaders) {
    for (const [operation, adapter] of Object.entries(module.mounts(modules, options))) {
      if (operation in adapters) {
        throw new Error(`Two adapter modules mount ${operation}`)
      }
      // Bind device writes to this recording’s effect sink before the adapter mounts.
      adapters[operation] = (context) => {
        device.bind(context.effect)
        // Bind salvage reads here too because classifiers load per adapter while the mount owns the recording.
        bindSalvageObserver(context.effect)
        return adapter(context)
      }
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
