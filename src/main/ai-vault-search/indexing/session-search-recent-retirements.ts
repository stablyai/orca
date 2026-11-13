type Row = { path: string; mtimeMs: number; order: number }

export class SessionSearchRecentRetirements {
  private readonly heap: Row[] = []
  private order = 0
  constructor(private readonly limit: number) {}
  private compare(left: Row, right: Row): number {
    return left.mtimeMs - right.mtimeMs || right.order - left.order
  }
  add(file: { path: string; mtimeMs: number }): void {
    const row = { ...file, order: this.order++ }
    if (this.heap.length < this.limit) {
      let index = this.heap.length
      this.heap.push(row)
      while (index > 0) {
        const parent = (index - 1) >>> 1
        if (this.compare(this.heap[parent], row) <= 0) {
          break
        }
        this.heap[index] = this.heap[parent]
        index = parent
      }
      this.heap[index] = row
    } else if (this.limit > 0 && this.compare(row, this.heap[0]) > 0) {
      this.place(row, this.heap.length)
    }
  }
  private place(row: Row, size: number): void {
    let index = 0
    while (index * 2 + 1 < size) {
      let child = index * 2 + 1
      if (child + 1 < size && this.compare(this.heap[child + 1], this.heap[child]) < 0) {
        child++
      }
      if (this.compare(row, this.heap[child]) <= 0) {
        break
      }
      this.heap[index] = this.heap[child]
      index = child
    }
    this.heap[index] = row
  }
  paths(): string[] {
    const paths: string[] = []
    while (this.heap.length) {
      paths.push(this.heap[0].path)
      const last = this.heap.pop()!
      if (this.heap.length) {
        this.place(last, this.heap.length)
      }
    }
    return paths.toReversed()
  }
}
