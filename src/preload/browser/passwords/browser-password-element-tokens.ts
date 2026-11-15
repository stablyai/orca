// Why not crypto.randomUUID: plain-HTTP pages lack it, and the sandboxed preload can't import shared code.
function createElementToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/**
 * Random per-document handles for page objects. Kept in the isolated world, never written onto
 * the element, so page script can neither read nor forge them.
 */
export type BrowserPasswordElementTokens<T extends object> = {
  tokenFor: (target: T) => string
  resolve: (token: string) => T | null
}

const PRUNE_THRESHOLD = 256

export function createBrowserPasswordElementTokens<
  T extends object
>(): BrowserPasswordElementTokens<T> {
  const tokenByTarget = new WeakMap<T, string>()
  const targetByToken = new Map<string, WeakRef<T>>()

  const prune = (): void => {
    for (const [token, ref] of targetByToken) {
      if (ref.deref() === undefined) {
        targetByToken.delete(token)
      }
    }
  }

  return {
    tokenFor(target) {
      const existing = tokenByTarget.get(target)
      if (existing) {
        return existing
      }
      if (targetByToken.size >= PRUNE_THRESHOLD) {
        prune()
      }
      const token = createElementToken()
      tokenByTarget.set(target, token)
      targetByToken.set(token, new WeakRef(target))
      return token
    },
    resolve(token) {
      return targetByToken.get(token)?.deref() ?? null
    }
  }
}
