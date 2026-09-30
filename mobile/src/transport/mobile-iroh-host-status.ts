// Compact per-host iroh diagnostic for connection UI (home card / session header).

export type IrohHostStatusPhase = 'idle' | 'attempting' | 'failed'

export type IrohHostStatus = {
  phase: IrohHostStatusPhase
  detail: string
  updatedAt: number
}

const byHost = new Map<string, IrohHostStatus>()
const listeners = new Set<() => void>()

export function setIrohHostStatus(
  hostId: string,
  phase: IrohHostStatusPhase,
  detail = '',
  nowMs = Date.now()
): void {
  byHost.set(hostId, { phase, detail, updatedAt: nowMs })
  for (const listener of listeners) {
    listener()
  }
}

export function getIrohHostStatus(hostId: string): IrohHostStatus | null {
  return byHost.get(hostId) ?? null
}

export function subscribeIrohHostStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Compact line for status meta, e.g. "Iroh attempting…" / "Iroh failed: native_module_unavailable". */
export function irohStatusDisplayLabel(status: IrohHostStatus | null | undefined): string | null {
  if (!status || status.phase === 'idle') {
    return null
  }
  if (status.phase === 'attempting') {
    return 'Iroh attempting…'
  }
  return status.detail ? `Iroh failed: ${status.detail}` : 'Iroh failed'
}

/** Test-only. */
export function resetIrohHostStatusForTests(): void {
  byHost.clear()
  listeners.clear()
}
