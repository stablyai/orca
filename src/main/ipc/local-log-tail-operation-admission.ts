export const MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER = 32
export const MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE = 128
export const MAX_LOCAL_LOG_TAIL_READS_PER_SENDER = 16
export const MAX_LOCAL_LOG_TAIL_READS_PROCESS_WIDE = 64

class ScopedLocalLogTailClaims {
  private readonly claims = new Set<symbol>()
  private readonly claimsBySender = new Map<number, Set<symbol>>()

  constructor(
    private readonly maxPerSender: number,
    private readonly maxProcessWide: number,
    private readonly label: string
  ) {}

  claim(senderId: number, errorMessage: string): symbol {
    const senderClaims = this.claimsBySender.get(senderId)
    if ((senderClaims?.size ?? 0) >= this.maxPerSender || this.claims.size >= this.maxProcessWide) {
      throw new Error(errorMessage)
    }
    const token = Symbol(this.label)
    const nextSenderClaims = senderClaims ?? new Set<symbol>()
    nextSenderClaims.add(token)
    this.claimsBySender.set(senderId, nextSenderClaims)
    this.claims.add(token)
    return token
  }

  release(senderId: number, token: symbol): void {
    this.claims.delete(token)
    const senderClaims = this.claimsBySender.get(senderId)
    senderClaims?.delete(token)
    if (senderClaims?.size === 0) {
      this.claimsBySender.delete(senderId)
    }
  }

  reset(): void {
    this.claims.clear()
    this.claimsBySender.clear()
  }

  get size(): number {
    return this.claims.size
  }
}

export class LocalLogTailOperationAdmission {
  private readonly starts = new ScopedLocalLogTailClaims(
    MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER,
    MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE,
    'local-log-tail-start'
  )
  private readonly reads = new ScopedLocalLogTailClaims(
    MAX_LOCAL_LOG_TAIL_READS_PER_SENDER,
    MAX_LOCAL_LOG_TAIL_READS_PROCESS_WIDE,
    'local-log-tail-read'
  )

  claimStart(senderId: number): symbol {
    return this.starts.claim(senderId, 'Too many local log tail starts')
  }

  releaseStart(senderId: number, token: symbol): void {
    this.starts.release(senderId, token)
  }

  claimRead(senderId: number): symbol {
    return this.reads.claim(senderId, 'Too many concurrent local log tail reads')
  }

  releaseRead(senderId: number, token: symbol): void {
    this.reads.release(senderId, token)
  }

  reset(): void {
    this.starts.reset()
    this.reads.reset()
  }

  get pendingStartCount(): number {
    return this.starts.size
  }

  get pendingReadCount(): number {
    return this.reads.size
  }
}
