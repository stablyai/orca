/** E9: each window reports its own open WSL host work; the service sees their union. */
export class WslHostVisibleWorkByWindow {
  private readonly byWindow = new Map<number, readonly string[]>()

  has(windowId: number): boolean {
    return this.byWindow.has(windowId)
  }

  /** Returns the union to hand the service. */
  report(windowId: number, environmentIds: readonly string[]): string[] {
    this.byWindow.set(windowId, environmentIds)
    return this.union()
  }

  /** A closed window's work no longer counts. */
  forget(windowId: number): string[] {
    this.byWindow.delete(windowId)
    return this.union()
  }

  private union(): string[] {
    return [...new Set([...this.byWindow.values()].flat())].sort()
  }
}
