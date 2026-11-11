type Link<T> = { key: string; value: T; previous?: Link<T>; next?: Link<T> }

/** Keyed obligations retain their FIFO position until acknowledged or cancelled. */
export class SessionInputFrontier<T> {
  private readonly members = new Map<string, Link<T>>()
  private head: Link<T> | undefined
  private tail: Link<T> | undefined

  get size(): number {
    return this.members.size
  }
  get first(): T | undefined {
    return this.head?.value
  }
  firstEntry(): readonly [string, T] | undefined {
    return this.head ? [this.head.key, this.head.value] : undefined
  }
  has(key: string): boolean {
    return this.members.has(key)
  }
  get(key: string): T | undefined {
    return this.members.get(key)?.value
  }
  set(key: string, value: T): void {
    const current = this.members.get(key)
    if (current) {
      current.value = value
      return
    }
    const link: Link<T> = { key, value, previous: this.tail }
    if (this.tail) {
      this.tail.next = link
    } else {
      this.head = link
    }
    this.tail = link
    this.members.set(key, link)
  }
  delete(key: string): void {
    const link = this.members.get(key)
    if (!link) {
      return
    }
    if (link.previous) {
      link.previous.next = link.next
    } else {
      this.head = link.next
    }
    if (link.next) {
      link.next.previous = link.previous
    } else {
      this.tail = link.previous
    }
    this.members.delete(key)
    link.previous = undefined
    link.next = undefined
  }
}
