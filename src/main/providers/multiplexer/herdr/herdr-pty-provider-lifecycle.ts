import type { HerdrPtyBinding } from './herdr-pty-types'
import type { HerdrRuntimeManager } from './herdr-runtime-manager'

export function disposeProvider(
  bindings: Map<string, HerdrPtyBinding>,
  managers: Map<string, HerdrRuntimeManager>
): void {
  for (const binding of bindings.values()) {
    binding.detached = true
    for (const unsubscribe of binding.unsubscribe.splice(0)) {
      unsubscribe()
    }
    binding.controller.release()
    bindings.delete(binding.id)
  }
  for (const manager of managers.values()) {
    manager.dispose()
  }
  managers.clear()
}
