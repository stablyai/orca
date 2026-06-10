import { randomUUID } from 'crypto'

export type PortEntry = {
  port: number
  authToken: string
}

export class PortRegistry {
  private byWorktree = new Map<string, PortEntry>()
  private byPort = new Map<number, string>()

  allocate(worktreeId: string, port: number): PortEntry {
    const entry: PortEntry = { port, authToken: randomUUID() }
    this.byWorktree.set(worktreeId, entry)
    this.byPort.set(port, worktreeId)
    return entry
  }

  worktreeForPort(port: number): string | undefined {
    return this.byPort.get(port)
  }

  entry(worktreeId: string): PortEntry | undefined {
    return this.byWorktree.get(worktreeId)
  }

  setPort(worktreeId: string, port: number): void {
    const entry = this.byWorktree.get(worktreeId)
    if (!entry) {return}
    this.byPort.delete(entry.port)
    entry.port = port
    this.byPort.set(port, worktreeId)
  }

  release(worktreeId: string): void {
    const entry = this.byWorktree.get(worktreeId)
    if (!entry) {return}
    this.byPort.delete(entry.port)
    this.byWorktree.delete(worktreeId)
  }
}
