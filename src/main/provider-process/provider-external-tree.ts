import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ProviderProcessTree } from './provider-process-close'

/** A late SDK tree joins cleanup without replaying the process-group ladder. */
export class ProviderExternalTree {
  current: ProviderProcessTree | undefined
  private readonly flights = new WeakMap<ProviderProcessTree, Promise<DescendantTreeVerdict>>()
  private completed: ProviderProcessTree | undefined

  get owed(): boolean {
    return this.current !== undefined && this.current !== this.completed
  }

  async reap(): Promise<DescendantTreeVerdict | null> {
    const tree = this.current
    if (!tree) {
      return null
    }
    let flight = this.flights.get(tree)
    if (!flight) {
      flight = tree.reap()
      this.flights.set(tree, flight)
      void flight.then(
        (verdict) => {
          if (verdict === 'exited') {
            this.completed = tree
          } else {
            this.flights.delete(tree)
          }
        },
        () => this.flights.delete(tree)
      )
    }
    const verdict = await flight
    return this.current === tree ? verdict : this.reap()
  }
}
