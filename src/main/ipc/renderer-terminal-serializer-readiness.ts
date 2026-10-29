type RendererTerminalSerializerWaiter = {
  afterGeneration: number
  finish: (ready: boolean) => void
}

export class RendererTerminalSerializerReadiness {
  private incarnationSequence = 0
  private readonly incarnationByPtyId = new Map<string, number>()
  private readonly readyIncarnationByPtyId = new Map<string, number>()
  private readonly generationByPtyId = new Map<string, number>()
  private readonly waitersByPtyId = new Map<string, Set<RendererTerminalSerializerWaiter>>()

  has(ptyId: string): boolean {
    const incarnation = this.incarnationByPtyId.get(ptyId)
    return incarnation !== undefined && this.readyIncarnationByPtyId.get(ptyId) === incarnation
  }

  generation(ptyId: string): number {
    return this.generationByPtyId.get(ptyId) ?? 0
  }

  beginIncarnation(ptyId: string, inheritReady = false): number {
    const wasReady = this.has(ptyId)
    const incarnation = ++this.incarnationSequence
    this.incarnationByPtyId.set(ptyId, incarnation)
    if (inheritReady && wasReady) {
      this.readyIncarnationByPtyId.set(ptyId, incarnation)
    } else {
      this.readyIncarnationByPtyId.delete(ptyId)
    }
    return incarnation
  }

  markReady(ptyId: string): void {
    let incarnation = this.incarnationByPtyId.get(ptyId)
    if (incarnation === undefined) {
      incarnation = ++this.incarnationSequence
      this.incarnationByPtyId.set(ptyId, incarnation)
    }
    this.readyIncarnationByPtyId.set(ptyId, incarnation)
    const generation = this.generation(ptyId) + 1
    this.generationByPtyId.set(ptyId, generation)
    const waiters = this.waitersByPtyId.get(ptyId)
    if (!waiters) {
      return
    }
    for (const waiter of waiters) {
      if (generation > waiter.afterGeneration) {
        waiter.finish(true)
      }
    }
  }

  clear(ptyId: string, incarnation?: number): boolean {
    if (incarnation !== undefined && this.incarnationByPtyId.get(ptyId) !== incarnation) {
      return false
    }
    this.incarnationByPtyId.delete(ptyId)
    this.readyIncarnationByPtyId.delete(ptyId)
    this.generationByPtyId.delete(ptyId)
    this.finishWaiters(ptyId, false)
    return true
  }

  private finishWaiters(ptyId: string, ready: boolean): void {
    const waiters = this.waitersByPtyId.get(ptyId)
    if (!waiters) {
      return
    }
    for (const waiter of waiters) {
      waiter.finish(ready)
    }
  }

  wait(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.generation(ptyId) > afterGeneration) {
      return Promise.resolve(true)
    }
    if (signal?.aborted) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      let waiters = this.waitersByPtyId.get(ptyId)
      if (!waiters) {
        waiters = new Set()
        this.waitersByPtyId.set(ptyId, waiters)
      }

      const onAbort = (): void => finish(false)
      const waiter: RendererTerminalSerializerWaiter = {
        afterGeneration,
        finish: (ready) => finish(ready)
      }
      const finish = (ready: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        signal?.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) {
          this.waitersByPtyId.delete(ptyId)
        }
        resolve(ready)
      }

      waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(false), timeoutMs)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      }
    })
  }
}
