// Browsers mark cancel()’s rejected finished promise handled; patch happy-dom’s unhandled rejection or cancelled animations fail tests.

const patchedPrototypes = new WeakSet<Animation>()

export function installHappyDomAnimationCancel(): boolean {
  if (globalThis.Animation === undefined) {
    return false
  }
  const prototype = globalThis.Animation.prototype
  if (patchedPrototypes.has(prototype)) {
    return true
  }
  const cancel = prototype.cancel
  prototype.cancel = function cancelWithHandledFinish(this: Animation): void {
    this.finished.catch(() => {})
    cancel.call(this)
  }
  patchedPrototypes.add(prototype)
  return true
}

installHappyDomAnimationCancel()
