import type {
  RecoveryAgentBinding,
  RecoverySessionIdMapping
} from '../../../shared/cross-machine-recovery-descriptor'

function renameTranscriptBasename(transcriptPath: string, from: string, to: string): string {
  const cut = Math.max(transcriptPath.lastIndexOf('/'), transcriptPath.lastIndexOf('\\')) + 1
  return transcriptPath.slice(0, cut) + transcriptPath.slice(cut).replaceAll(from, to)
}

function rekeyBinding(binding: RecoveryAgentBinding, to: string): RecoveryAgentBinding {
  const from = binding.providerSession.id
  const { transcriptPath } = binding.providerSession
  return {
    ...binding,
    providerSession: {
      ...binding.providerSession,
      id: to,
      ...(transcriptPath !== undefined
        ? { transcriptPath: renameTranscriptBasename(transcriptPath, from, to) }
        : {})
    },
    ...(binding.structuredCursor?.sessionId === from
      ? { structuredCursor: { ...binding.structuredCursor, sessionId: to } }
      : {})
  }
}

/** Re-keys sessions the provider forked to their local ids, keeping each local id's source id. */
export function applyRecoverySessionIdMap(
  bindings: readonly RecoveryAgentBinding[],
  mappings: readonly RecoverySessionIdMapping[]
): { bindings: RecoveryAgentBinding[]; sourceIds: ReadonlyMap<string, string> } {
  const toLocal = new Map(mappings.map((mapping) => [mapping.from, mapping.to]))
  for (const from of toLocal.keys()) {
    if (!bindings.some((binding) => binding.providerSession.id === from)) {
      throw new Error('recovery_binding_not_found')
    }
  }
  const sourceIds = new Map<string, string>()
  const rekeyed = bindings.map((binding) => {
    const from = binding.providerSession.id
    const to = toLocal.get(from)
    sourceIds.set(to ?? from, from)
    return to === undefined ? binding : rekeyBinding(binding, to)
  })
  return { bindings: rekeyed, sourceIds }
}
