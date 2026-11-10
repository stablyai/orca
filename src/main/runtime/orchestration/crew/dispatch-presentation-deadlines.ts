/** One addressable deadline per eligible dispatch; removing its owner also removes its deadline. */
export class DispatchPresentationDeadlines {
  private readonly positions = new Map<string, number>()
  private readonly items: { id: string; at: number }[] = []

  set(id: string, at: number): void {
    this.delete(id)
    this.items.push({ id, at })
    this.positions.set(id, this.items.length - 1)
    this.up(this.items.length - 1)
  }

  delete(id: string): void {
    const index = this.positions.get(id)
    if (index === undefined) {
      return
    }
    const last = this.items.pop()!
    this.positions.delete(id)
    if (index >= this.items.length) {
      return
    }
    this.items[index] = last
    this.positions.set(last.id, index)
    const moved = this.up(index)
    if (moved === index) {
      this.down(index)
    }
  }

  *expired(now: number): Iterable<string> {
    while (this.items[0] && this.items[0].at < now) {
      const id = this.items[0].id
      this.delete(id)
      yield id
    }
  }

  clear(): void {
    this.items.length = 0
    this.positions.clear()
  }

  private swap(a: number, b: number): void {
    const entry = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = entry
    this.positions.set(this.items[a].id, a)
    this.positions.set(this.items[b].id, b)
  }

  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.items[parent].at <= this.items[index].at) {
        break
      }
      this.swap(index, parent)
      index = parent
    }
    return index
  }

  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      const child =
        right < this.items.length && this.items[right].at < this.items[left].at ? right : left
      if (child >= this.items.length || this.items[index].at <= this.items[child].at) {
        return
      }
      this.swap(index, child)
      index = child
    }
  }
}
