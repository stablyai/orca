// Why: the Web Animations spec marks the `finished` promise that cancel() rejects as handled, and
// Chromium does. happy-dom rejects it unhandled, so every cancelled animation fails the test run.

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
