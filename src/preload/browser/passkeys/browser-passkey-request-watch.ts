/**
 * Runs serialized in the page's main world. Electron tells main nothing about passkey requests, so
 * the page's calls report when the document starts and stops waiting on one. A request main won't
 * hand to the OS (Windows Hello would take the foreground) waits unsent until cancelled. Returns the canceller.
 */
export function installBrowserPasskeyRequestWatch(
  report: (pending: boolean) => void,
  mayAskSystem: () => boolean
): () => void {
  // Insecure documents have no credentials API.
  if (typeof CredentialsContainer === 'undefined') {
    return () => {}
  }
  const pending = new Set<AbortController>()
  // Requests main kept from the OS; the user's own later request replaces them.
  const held = new Set<AbortController>()
  // The page's own "user cancelled" path, so it offers another way to sign in.
  const cancelled = (): DOMException =>
    new DOMException('The passkey request was cancelled.', 'NotAllowedError')
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
        if (mayAskSystem()) {
          for (const stale of held) {
            stale.abort(cancelled())
          }
          request = original.call(this, withSignal)
        } else {
          held.add(controller)
          request = new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason)
              return
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
      } catch (error) {
        return Promise.reject(error)
      }
      pending.add(controller)
      if (pending.size === 1) {
        report(true)
      }
      const settle = (): void => {
        held.delete(controller)
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
      controller.abort(cancelled())
    }
  }
}
