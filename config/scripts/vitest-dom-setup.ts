/** Opt in when a fixture needs completed native mutations before automatic selection notifications. */
export function installHappyDomSelectionNotificationTasks(doc: Document): () => void {
  const ownerWindow = doc.defaultView
  const native = doc.getSelection()
  if (!ownerWindow || !native) {
    throw new Error('Expected a DOM selection and owning window')
  }
  const prototype = ownerWindow.Selection.prototype
  const mutationDescriptor = Object.getOwnPropertyDescriptor(prototype, 'setBaseAndExtent')
  if (!mutationDescriptor) {
    throw new Error('Expected native setBaseAndExtent descriptor')
  }
  const dispatchDescriptor = Object.getOwnPropertyDescriptor(doc, 'dispatchEvent')
  const mutate = prototype.setBaseAndExtent
  const dispatch = doc.dispatchEvent
  let mutationDepth = 0
  let cancelPending: (() => void) | null = null

  Object.defineProperty(doc, 'dispatchEvent', {
    configurable: true,
    writable: true,
    value(this: Document, event: Event): boolean {
      // The pinned emulator emits this event inside setBaseAndExtent, before assigning its final direction.
      if (
        this === doc &&
        mutationDepth > 0 &&
        event.type === 'selectionchange' &&
        !event.bubbles &&
        !event.cancelable
      ) {
        if (!cancelPending) {
          const schedule = ownerWindow.setTimeout.bind(ownerWindow)
          const cancel = ownerWindow.clearTimeout.bind(ownerWindow)
          const timer = schedule(() => {
            cancelPending = null
            doc.dispatchEvent(new ownerWindow.Event('selectionchange'))
          }, 0)
          cancelPending = () => cancel(timer)
        }
        return true
      }
      return dispatch.call(this, event)
    }
  })
  Object.defineProperty(prototype, 'setBaseAndExtent', {
    ...mutationDescriptor,
    value(this: Selection, ...args: Parameters<Selection['setBaseAndExtent']>): void {
      if (this !== native) {
        return mutate.call(this, ...args)
      }
      mutationDepth++
      try {
        return mutate.call(this, ...args)
      } finally {
        mutationDepth--
      }
    }
  })
  return () => {
    cancelPending?.()
    cancelPending = null
    Object.defineProperty(prototype, 'setBaseAndExtent', mutationDescriptor)
    if (dispatchDescriptor) {
      Object.defineProperty(doc, 'dispatchEvent', dispatchDescriptor)
    } else {
      Reflect.deleteProperty(doc, 'dispatchEvent')
    }
  }
}

// DOM compatibility patches are only needed after Vitest installs a DOM environment.
if (globalThis.document !== undefined) {
  await import('./happy-dom-offscreen-canvas')
  await import('./happy-dom-mutation-observer-retention')
  await import('./happy-dom-animation-cancel')
}
