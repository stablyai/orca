/** Invocation-local successor queries over sorted coordinates, with point activation. */
export class OrderedAvailability {
  private readonly capacity: number
  private readonly maximum: number[]

  constructor(
    private readonly coordinates: readonly number[],
    private readonly check: () => void,
    enabled = true
  ) {
    let capacity = 1
    while (capacity < coordinates.length) {
      check()
      capacity *= 2
    }
    this.capacity = capacity
    this.maximum = Array.from({ length: capacity * 2 }, () => -Infinity)
    for (let index = 0; index < coordinates.length; index++) {
      check()
      if (enabled) {
        this.maximum[capacity + index] = coordinates[index]
      }
    }
    for (let index = capacity - 1; index > 0; index--) {
      check()
      this.maximum[index] = Math.max(this.maximum[index * 2], this.maximum[index * 2 + 1])
    }
  }

  after(floor: number): { index: number; value: number } | undefined {
    this.check()
    if (this.maximum[1] <= floor) {
      return undefined
    }
    let node = 1
    while (node < this.capacity) {
      this.check()
      node *= 2
      if (this.maximum[node] <= floor) {
        node += 1
      }
    }
    const index = node - this.capacity
    return { index, value: this.coordinates[index] }
  }

  set(index: number, enabled: boolean): void {
    this.check()
    let node = this.capacity + index
    this.maximum[node] = enabled ? this.coordinates[index] : -Infinity
    while (node > 1) {
      this.check()
      node = Math.floor(node / 2)
      this.maximum[node] = Math.max(this.maximum[node * 2], this.maximum[node * 2 + 1])
    }
  }
}
