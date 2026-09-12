const fences = new WeakMap<object, Set<string>>()

export function isOutgoingPtyRegistrationFenced(runtime: object, ptyId: string): boolean {
  return fences.get(runtime)?.has(ptyId) === true
}

/** Caller holds cleanup authority; only explicit recovery may later reopen these routes. */
export function fenceOutgoingPtyRegistrations(runtime: object, ptyIds: readonly string[]): void {
  let fenced = fences.get(runtime)
  if (!fenced) {
    fenced = new Set()
    fences.set(runtime, fenced)
  }
  for (const id of ptyIds) {
    fenced.add(id)
  }
}

export function assertOutgoingPtyRegistrationAllowed(runtime: object, ptyId: string): void {
  if (fences.get(runtime)?.has(ptyId)) {
    throw new Error('orcad_outgoing_source_registration_fenced')
  }
}

export function assertOutgoingPtyModelMutationAllowed(runtime: object, ptyId: string): void {
  if (fences.get(runtime)?.has(ptyId)) {
    throw new Error('orcad_outgoing_source_model_mutation_fenced')
  }
}

export function assertOutgoingPtyGraphPublicationAllowed(
  runtime: object,
  leaves: Iterable<{ ptyId?: string | null }>
): void {
  const fenced = fences.get(runtime)
  if (!fenced?.size) {
    return
  }
  for (const leaf of leaves) {
    if (leaf.ptyId && fenced.has(leaf.ptyId)) {
      throw new Error('orcad_outgoing_source_graph_publication_fenced')
    }
  }
}
