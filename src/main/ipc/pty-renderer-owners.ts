import type { WebContents } from 'electron'

export type PtyRendererOwner = {
  webContentsId: number
  generation: number
}

type RendererState = {
  webContents: WebContents
  generation: number
  dispatcherReady: boolean
  readyFrame: WebContents['mainFrame'] | null
  active: Set<string>
  visible: Set<string>
  hidden: Set<string>
  interested: Set<string>
}

type ReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const isDestroyed = (webContents: WebContents): boolean =>
  typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()

export class PtyRendererOwners {
  readonly #renderers = new Map<number, RendererState>()
  readonly #owners = new Map<string, PtyRendererOwner>()
  readonly #readyWaiters = new Map<number, Set<ReadyWaiter>>()

  registerRenderer(webContents: WebContents): void {
    const existing = this.#renderers.get(webContents.id)
    if (existing) {
      if (existing.webContents !== webContents) {
        throw new Error('untrusted_ui_renderer')
      }
      return
    }
    this.#renderers.set(webContents.id, {
      webContents,
      generation: 0,
      dispatcherReady: false,
      readyFrame: null,
      active: new Set(),
      visible: new Set(),
      hidden: new Set(),
      interested: new Set()
    })
  }

  claim(ptyId: string, sender: WebContents): PtyRendererOwner {
    const renderer = this.#requireRenderer(sender)
    const existing = this.#owners.get(ptyId)
    if (existing && existing.webContentsId !== sender.id) {
      throw new Error('pty_renderer_owned')
    }
    const owner = existing ?? {
      webContentsId: sender.id,
      generation: renderer.generation
    }
    this.#owners.set(ptyId, owner)
    return { ...owner }
  }

  owns(ptyId: string, sender: WebContents): boolean {
    const owner = this.#owners.get(ptyId)
    const renderer = this.#renderers.get(sender.id)
    return (
      owner?.webContentsId === sender.id && renderer?.webContents === sender && !isDestroyed(sender)
    )
  }

  isRegistered(sender: WebContents): boolean {
    const renderer = this.#renderers.get(sender.id)
    return renderer?.webContents === sender && !isDestroyed(sender)
  }

  getOwner(ptyId: string): PtyRendererOwner | null {
    const owner = this.#owners.get(ptyId)
    return owner ? { ...owner } : null
  }

  release(ptyId: string): void {
    const owner = this.#owners.get(ptyId)
    if (owner) {
      this.#deleteViewFlags(owner.webContentsId, ptyId)
    }
    this.#owners.delete(ptyId)
  }

  getOwnedIds(sender: WebContents): string[] {
    this.#requireRenderer(sender)
    return this.#ownedIds(sender.id)
  }

  getOwnedIdsExcept(sender: WebContents): string[] {
    this.#requireRenderer(sender)
    return [...this.#owners]
      .filter(([, owner]) => owner.webContentsId !== sender.id)
      .map(([id]) => id)
  }

  getTarget(ptyId: string): WebContents | null {
    const owner = this.#owners.get(ptyId)
    if (!owner) {
      return null
    }
    const target = this.#renderers.get(owner.webContentsId)?.webContents
    return target && !isDestroyed(target) ? target : null
  }

  markDispatcherReady(sender: WebContents, frame = sender.mainFrame): void {
    const renderer = this.#requireRenderer(sender)
    renderer.dispatcherReady = true
    renderer.readyFrame = frame
    const waiters = this.#readyWaiters.get(sender.id)
    if (!waiters) {
      return
    }
    this.#readyWaiters.delete(sender.id)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  waitUntilDispatcherReady(sender: WebContents, timeoutMs: number): Promise<void> {
    if (this.#requireRenderer(sender).dispatcherReady) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#readyWaiters.get(sender.id)?.delete(waiter)
          reject(new Error('pty_renderer_ready_timeout'))
        }, timeoutMs)
      }
      const waiters = this.#readyWaiters.get(sender.id) ?? new Set<ReadyWaiter>()
      waiters.add(waiter)
      this.#readyWaiters.set(sender.id, waiters)
    })
  }

  isDispatcherReady(sender: WebContents): boolean {
    return this.#requireRenderer(sender).dispatcherReady
  }

  isDispatcherReadyForFrame(sender: WebContents, frame: WebContents['mainFrame']): boolean {
    const renderer = this.#requireRenderer(sender)
    return renderer.dispatcherReady && renderer.readyFrame === frame
  }

  isDispatcherReadyFor(ptyId: string): boolean {
    const owner = this.#owners.get(ptyId)
    return owner ? this.#renderers.get(owner.webContentsId)?.dispatcherReady === true : false
  }

  setActive(sender: WebContents, ptyId: string, value: boolean): void {
    this.#setViewFlag(sender, ptyId, value, 'active')
  }

  setVisible(sender: WebContents, ptyId: string, value: boolean): void {
    this.#setViewFlag(sender, ptyId, value, 'visible')
  }

  setHidden(sender: WebContents, ptyId: string, value: boolean): void {
    this.#setViewFlag(sender, ptyId, value, 'hidden')
  }

  setInterested(sender: WebContents, ptyId: string, value: boolean): void {
    this.#setViewFlag(sender, ptyId, value, 'interested')
  }

  getViewState(ptyId: string): {
    active: boolean
    visible: boolean
    hidden: boolean
    interested: boolean
  } {
    const owner = this.#owners.get(ptyId)
    const renderer = owner ? this.#renderers.get(owner.webContentsId) : undefined
    return {
      active: renderer?.active.has(ptyId) ?? false,
      visible: renderer?.visible.has(ptyId) ?? false,
      hidden: renderer?.hidden.has(ptyId) ?? false,
      interested: renderer?.interested.has(ptyId) ?? false
    }
  }

  beginReload(sender: WebContents): string[] {
    const renderer = this.#requireRenderer(sender)
    const ownedIds = this.#ownedIds(sender.id)
    const highestOwnerGeneration = Math.max(
      renderer.generation,
      ...ownedIds.map((id) => this.#owners.get(id)?.generation ?? 0)
    )
    renderer.generation = highestOwnerGeneration + 1
    renderer.dispatcherReady = false
    renderer.readyFrame = null
    renderer.active.clear()
    renderer.visible.clear()
    renderer.hidden.clear()
    renderer.interested.clear()
    for (const id of ownedIds) {
      this.#owners.set(id, { webContentsId: sender.id, generation: renderer.generation })
    }
    return ownedIds
  }

  handoff(
    ptyIds: readonly string[],
    from: WebContents,
    to: WebContents
  ): { id: string; fromGeneration: number; toGeneration: number }[] {
    this.#requireRenderer(from)
    const target = this.#requireRenderer(to)
    if (new Set(ptyIds).size !== ptyIds.length) {
      throw new Error('pty_renderer_duplicate_handoff')
    }
    if (!target.dispatcherReady) {
      throw new Error('pty_renderer_not_ready')
    }
    for (const id of ptyIds) {
      if (!this.owns(id, from)) {
        throw new Error('pty_renderer_not_owner')
      }
    }
    const toGeneration =
      Math.max(
        target.generation,
        ...this.#ownedIds(to.id).map((id) => this.#owners.get(id)?.generation ?? 0),
        ...ptyIds.map((id) => this.#owners.get(id)!.generation)
      ) + 1
    target.generation = toGeneration
    return ptyIds.map((id) => {
      const owner = this.#owners.get(id)!
      this.#deleteViewFlags(from.id, id)
      this.#owners.set(id, { webContentsId: to.id, generation: toGeneration })
      return { id, fromGeneration: owner.generation, toGeneration }
    })
  }

  removeRenderer(sender: WebContents): string[] {
    if (this.#renderers.get(sender.id)?.webContents !== sender) {
      return []
    }
    const ownedIds = this.#ownedIds(sender.id)
    for (const id of ownedIds) {
      this.#owners.delete(id)
    }
    this.#renderers.delete(sender.id)
    const waiters = this.#readyWaiters.get(sender.id)
    this.#readyWaiters.delete(sender.id)
    for (const waiter of waiters ?? []) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('pty_renderer_destroyed'))
    }
    return ownedIds
  }

  #setViewFlag(
    sender: WebContents,
    ptyId: string,
    value: boolean,
    key: 'active' | 'visible' | 'hidden' | 'interested'
  ): void {
    const renderer = this.#requireRenderer(sender)
    if (!this.owns(ptyId, sender)) {
      throw new Error('pty_renderer_not_owner')
    }
    if (value) {
      renderer[key].add(ptyId)
    } else {
      renderer[key].delete(ptyId)
    }
  }

  #deleteViewFlags(webContentsId: number, ptyId: string): void {
    const renderer = this.#renderers.get(webContentsId)
    renderer?.active.delete(ptyId)
    renderer?.visible.delete(ptyId)
    renderer?.hidden.delete(ptyId)
    renderer?.interested.delete(ptyId)
  }

  #ownedIds(webContentsId: number): string[] {
    return [...this.#owners]
      .filter(([, owner]) => owner.webContentsId === webContentsId)
      .map(([id]) => id)
  }

  #requireRenderer(sender: WebContents): RendererState {
    const renderer = this.#renderers.get(sender.id)
    if (!renderer || renderer.webContents !== sender || isDestroyed(sender)) {
      throw new Error('untrusted_ui_renderer')
    }
    return renderer
  }
}

export const ptyRendererOwners = new PtyRendererOwners()
