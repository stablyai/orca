export type CrewFacet = 'topology' | 'records' | 'status' | 'names' | 'traffic'
export type CrewInvalidation = ReadonlySet<CrewFacet> & { readonly recordIds?: readonly string[] }

/** Invalidation is synchronous; the existing stream scheduler reads only after the commit. */
export class CrewChanges {
  private readonly listeners = new Set<(facets: CrewInvalidation) => void>()

  subscribe = (listener: (facets: CrewInvalidation) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify = (facets: CrewInvalidation = new Set(['topology'])): void => {
    for (const listener of this.listeners) {
      listener(facets)
    }
  }
}

export const sessionCrewChanges = new CrewChanges()
