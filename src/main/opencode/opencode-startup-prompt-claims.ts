import type { TerminalRunFacts } from '../runtime/terminal-run-facts'

type PromptClaim = {
  digest: string
  expiresAt: number
  admitted: boolean
  grantedRequestId?: string
  readOwner: () => TerminalRunFacts | 'pending' | null
  cleanup: () => void
  expiry: ReturnType<typeof setTimeout>
}

/** Authorizes one startup operation against current execution-owner facts. */
export class OpenCodeStartupPromptClaims {
  private readonly pending = new Map<string, PromptClaim>()

  constructor(private readonly now: () => number = Date.now) {}

  register(
    nonce: string,
    digest: string,
    readOwner: PromptClaim['readOwner'],
    cleanup = () => {}
  ): boolean {
    const now = this.now()
    for (const [key, claim] of this.pending) {
      if (claim.expiresAt <= now) {
        this.cancel(key)
      }
    }
    if (this.pending.size >= 128 || this.pending.has(nonce)) {
      return false
    }
    const expiry = setTimeout(() => this.cancel(nonce), 20000)
    expiry.unref?.()
    this.pending.set(nonce, {
      digest,
      readOwner,
      expiresAt: now + 20000,
      admitted: false,
      cleanup,
      expiry
    })
    return true
  }

  admit(nonce: string, readOwner: PromptClaim['readOwner'], cleanup = () => {}): boolean {
    const pending = this.pending.get(nonce)
    if (!pending || pending.expiresAt <= this.now()) {
      this.cancel(nonce)
      return false
    }
    if (pending.admitted || pending.grantedRequestId !== undefined) {
      return false
    }
    clearTimeout(pending.expiry)
    pending.expiresAt = this.now() + 20000
    pending.expiry = setTimeout(() => this.cancel(nonce), 20000)
    pending.expiry.unref?.()
    pending.admitted = true
    pending.readOwner = readOwner
    pending.cleanup = cleanup
    return true
  }

  cancel(nonce: string): void {
    const pending = this.pending.get(nonce)
    this.pending.delete(nonce)
    if (pending) {
      clearTimeout(pending.expiry)
    }
    pending?.cleanup()
  }

  clear(): void {
    for (const nonce of this.pending.keys()) {
      this.cancel(nonce)
    }
  }

  claim(body: unknown): boolean | 'pending' {
    if (!body || typeof body !== 'object' || !('nonce' in body) || typeof body.nonce !== 'string') {
      return false
    }
    const pending = this.pending.get(body.nonce)
    if (
      !pending ||
      pending.expiresAt <= this.now() ||
      !('digest' in body) ||
      body.digest !== pending.digest
    ) {
      this.cancel(body.nonce)
      return false
    }
    const requestId = 'requestId' in body ? body.requestId : undefined
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))
    ) {
      return false
    }
    if (pending.grantedRequestId !== undefined && pending.grantedRequestId !== requestId) {
      return false
    }
    const owner = pending.readOwner()
    if (owner === 'pending') {
      return 'pending'
    }
    if (owner?.freshSpawn !== true || owner.firstUserInputAt !== null) {
      this.cancel(body.nonce)
      return false
    }
    if (requestId === undefined) {
      this.cancel(body.nonce)
    } else {
      pending.grantedRequestId = requestId
    }
    return true
  }
}
