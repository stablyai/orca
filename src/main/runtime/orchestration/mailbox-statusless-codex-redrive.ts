const REDRIVE_FALLBACK_MS = 1_000

type DeferredRedrive = {
  sequence: number
  armed: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class OrchestrationMailboxStatuslessCodexRedrive {
  private readonly redrivesByPtyId = new Map<string, Map<string, DeferredRedrive>>()
  private readonly armedPtyIds = new Set<string>()

  constructor(private readonly redrive: (mailboxHandle: string) => void) {}

  schedule(ptyId: string, mailboxHandle: string, sequence: number): boolean {
    const deferred = this.redrivesByPtyId.get(ptyId) ?? new Map()
    const existing = deferred.get(mailboxHandle)
    if (existing && existing.sequence >= sequence) {
      return false
    }
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const retry = { sequence, armed: true, timer: null as ReturnType<typeof setTimeout> | null }
    retry.timer = setTimeout(() => {
      const current = this.redrivesByPtyId.get(ptyId)?.get(mailboxHandle)
      if (current === retry && retry.armed) {
        this.consume(ptyId, mailboxHandle, retry)
      }
    }, REDRIVE_FALLBACK_MS)
    retry.timer.unref?.()
    deferred.set(mailboxHandle, retry)
    this.redrivesByPtyId.set(ptyId, deferred)
    this.armedPtyIds.add(ptyId)
    return true
  }

  clear(ptyId: string, mailboxHandle: string, sequence: number): void {
    const deferred = this.redrivesByPtyId.get(ptyId)
    const retry = deferred?.get(mailboxHandle)
    if (!deferred || !retry || retry.sequence > sequence) {
      return
    }
    if (retry.timer) {
      clearTimeout(retry.timer)
    }
    deferred.delete(mailboxHandle)
    if (deferred.size === 0) {
      this.redrivesByPtyId.delete(ptyId)
      this.armedPtyIds.delete(ptyId)
    }
  }

  retirePty(ptyId: string): void {
    for (const retry of this.redrivesByPtyId.get(ptyId)?.values() ?? []) {
      if (retry.timer) {
        clearTimeout(retry.timer)
      }
    }
    this.redrivesByPtyId.delete(ptyId)
    this.armedPtyIds.delete(ptyId)
  }

  handlePtyOutput(ptyId: string): void {
    if (!this.armedPtyIds.delete(ptyId)) {
      return
    }
    const deferred = this.redrivesByPtyId.get(ptyId)
    for (const [mailboxHandle, retry] of deferred ?? []) {
      if (retry.armed) {
        this.consume(ptyId, mailboxHandle, retry)
      }
    }
  }

  private consume(ptyId: string, mailboxHandle: string, retry: DeferredRedrive): void {
    retry.armed = false
    if (retry.timer) {
      clearTimeout(retry.timer)
      retry.timer = null
    }
    this.refreshArmedPty(ptyId)
    this.redrive(mailboxHandle)
  }

  private refreshArmedPty(ptyId: string): void {
    for (const retry of this.redrivesByPtyId.get(ptyId)?.values() ?? []) {
      if (retry.armed) {
        this.armedPtyIds.add(ptyId)
        return
      }
    }
    this.armedPtyIds.delete(ptyId)
  }
}
