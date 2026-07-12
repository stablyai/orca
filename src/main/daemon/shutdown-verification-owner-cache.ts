export class ShutdownVerificationOwnerCache<T> {
  private readonly owners = new Map<string, T>()

  constructor(private readonly limit = 4_096) {}

  delete(id: string): void {
    this.owners.delete(id)
  }

  clear(): void {
    this.owners.clear()
  }

  take(id: string): T | undefined {
    const owner = this.owners.get(id)
    this.owners.delete(id)
    return owner
  }

  remember(id: string, owner: T): void {
    this.owners.delete(id)
    this.owners.set(id, owner)
    if (this.owners.size > this.limit) {
      const oldest = this.owners.keys().next().value
      if (oldest !== undefined) {
        this.owners.delete(oldest)
      }
    }
  }
}
