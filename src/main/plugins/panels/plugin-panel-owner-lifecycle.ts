import type { WebContents } from 'electron'

export type PluginPanelOwnerSender = Pick<WebContents, 'once' | 'removeListener'>

type OwnerState = {
  bound: boolean
  generation: number
}

const ownerStates = new WeakMap<PluginPanelOwnerSender, OwnerState>()

/** Deduplicates WebContents lifecycle hooks and returns a generation lease so
 *  an async panel load cannot publish a session after its renderer died. */
export function bindPluginPanelOwnerLifecycle(
  sender: PluginPanelOwnerSender,
  revoke: () => void
): { isCurrent: () => boolean } {
  let state = ownerStates.get(sender)
  if (!state) {
    state = { bound: false, generation: 0 }
    ownerStates.set(sender, state)
  }
  if (!state.bound) {
    state.bound = true
    let finished = false
    const cleanup = (): void => {
      if (finished) {
        return
      }
      finished = true
      sender.removeListener('destroyed', cleanup)
      sender.removeListener('render-process-gone', cleanup)
      state!.bound = false
      state!.generation += 1
      revoke()
    }
    sender.once('destroyed', cleanup)
    sender.once('render-process-gone', cleanup)
  }
  const generation = state.generation
  return { isCurrent: () => state!.bound && state!.generation === generation }
}
