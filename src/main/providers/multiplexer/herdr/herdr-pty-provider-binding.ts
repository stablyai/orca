import type { HerdrPtyBinding } from './herdr-pty-types'

export function bindController(
  input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
): HerdrPtyBinding {
  return {
    ...input,
    sequenceChars: 0,
    snapshot: '',
    detached: false,
    unsubscribe: []
  }
}

export function detachBinding(
  binding: HerdrPtyBinding,
  bindings: Map<string, HerdrPtyBinding>
): void {
  if (binding.detached) {
    return
  }
  binding.detached = true
  for (const unsubscribe of binding.unsubscribe.splice(0)) {
    unsubscribe()
  }
  binding.controller.release()
  bindings.delete(binding.id)
}
