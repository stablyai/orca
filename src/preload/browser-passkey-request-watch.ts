/**
 * Runs serialized in the page's main world. Electron has no passkey UI and tells main nothing, so
 * the page's calls report when the document starts and stops waiting on one. Returns the canceller.
 */
export function installBrowserPasskeyRequestWatch(report: (pending: boolean) => void): () => void {
  // Insecure documents have no credentials API.
  if (typeof CredentialsContainer === 'undefined') {
    return () => {}
  }
  const pending = new Set<AbortController>()
  type Options = { publicKey?: unknown; mediation?: string; signal?: AbortSignal }
  type Request<O> = (options?: O) => Promise<Credential | null>
  const watch = <O extends Options>(original: Request<O>): Request<O> =>
    function (this: CredentialsContainer, options) {
      // Conditional requests wait on autofill and block nothing.
      if (!options?.publicKey || options.mediation === 'conditional') {
        return original.call(this, options)
      }
      const controller = new AbortController()
      let request: Promise<Credential | null>
      try {
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal
        // Swap only the signal; every other member reads from the page's own object.
        const withSignal = new Proxy(options, {
          get: (target, key) =>
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the page's object on purpose.
            key === 'signal' ? signal : Reflect.get(target, key)
        })
        request = original.call(this, withSignal)
      } catch (error) {
        return Promise.reject(error)
      }
      pending.add(controller)
      if (pending.size === 1) {
        report(true)
      }
      const settle = (): void => {
        if (pending.delete(controller) && pending.size === 0) {
          report(false)
        }
      }
      // A derived promise keeps an unhandled rejection unhandled for the page.
      return request.finally(settle)
    }
  const credentials = CredentialsContainer.prototype
  credentials.get = watch(credentials.get)
  credentials.create = watch(credentials.create)
  return () => {
    for (const controller of pending) {
      // The page's own "user cancelled" path, so it offers another way to sign in.
      controller.abort(new DOMException('The passkey request was cancelled.', 'NotAllowedError'))
    }
  }
}
