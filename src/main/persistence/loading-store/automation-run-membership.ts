import type { AutomationRun } from '../../../shared/automations-types'

/** Share one raw-identity projection per immutable run-array revision. */
export class AutomationRunMembership {
  private rows: readonly AutomationRun[] | undefined
  private ids = new Set<string>()
  private readonly listeners = new Set<(id: string) => void>()

  constructor(
    private readonly read: () => readonly AutomationRun[],
    private readonly commits: Set<(generation: number) => void>
  ) {}

  sync(): void {
    const rows = this.read()
    if (rows === this.rows) {
      return
    }
    const ids = new Set(rows.map((run) => run.id))
    const previous = this.ids
    this.rows = rows
    this.ids = ids
    for (const id of previous) {
      if (ids.has(id)) {
        continue
      }
      for (const listener of this.listeners) {
        try {
          listener(id)
        } catch (error) {
          console.warn('[automations] Run removal observer failed:', error)
        }
      }
    }
  }

  has(id: string): boolean {
    this.sync()
    return this.ids.has(id)
  }

  observe(listener: (id: string) => void): () => void {
    this.sync()
    this.listeners.add(listener)
    const sync = () => this.sync()
    this.commits.add(sync)
    return () => {
      this.commits.delete(sync)
      this.listeners.delete(listener)
    }
  }
}
