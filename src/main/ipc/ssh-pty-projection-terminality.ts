import type { ProjectionRecord } from './ssh-pty-legacy-projection-record'

type ProjectionTerminalWaiter = {
  providerGeneration: number
  ptyIncarnation: string
  resolve: () => void
}

function matchesProjection(
  record: ProjectionRecord | undefined,
  providerGeneration: number,
  ptyIncarnation: string
): boolean {
  const identity = record?.semantics.identity
  return (
    identity?.providerGeneration === providerGeneration &&
    identity.ptyIncarnation === ptyIncarnation
  )
}

export function unpublishedProjectionIds(
  records: ReadonlyMap<string, ProjectionRecord>,
  ids: readonly string[],
  providerGeneration: number,
  ptyIncarnation: string
): string[] {
  return ids.filter((id) => {
    const record = records.get(id)
    return (
      record?.state === 'committed' && matchesProjection(record, providerGeneration, ptyIncarnation)
    )
  })
}

export function projectionHasOpen(
  records: ReadonlyMap<string, ProjectionRecord>,
  idsByPty: ReadonlyMap<string, readonly string[]>,
  ptyId: string
): (providerGeneration: number, ptyIncarnation: string) => boolean {
  return (providerGeneration, ptyIncarnation) =>
    (idsByPty.get(ptyId) ?? []).some((id) =>
      matchesProjection(records.get(id), providerGeneration, ptyIncarnation)
    )
}

export function resolveProjectionTerminality(
  terminality: SshPtyProjectionTerminality,
  records: ReadonlyMap<string, ProjectionRecord>,
  idsByPty: ReadonlyMap<string, readonly string[]>,
  ptyId: string
): void {
  terminality.resolve(ptyId, projectionHasOpen(records, idsByPty, ptyId))
}

export class SshPtyProjectionTerminality {
  private readonly waitersByPty = new Map<string, ProjectionTerminalWaiter[]>()

  whenTerminal(
    ptyId: string,
    providerGeneration: number,
    ptyIncarnation: string,
    hasOpen: (providerGeneration: number, ptyIncarnation: string) => boolean
  ): Promise<void> {
    if (!hasOpen(providerGeneration, ptyIncarnation)) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiters = this.waitersByPty.get(ptyId) ?? []
      waiters.push({ providerGeneration, ptyIncarnation, resolve })
      this.waitersByPty.set(ptyId, waiters)
    })
  }

  resolve(
    ptyId: string,
    hasOpen: (providerGeneration: number, ptyIncarnation: string) => boolean
  ): void {
    const waiters = this.waitersByPty.get(ptyId)
    if (!waiters) {
      return
    }
    const pending = waiters.filter((waiter) =>
      hasOpen(waiter.providerGeneration, waiter.ptyIncarnation)
    )
    for (const waiter of waiters) {
      if (!pending.includes(waiter)) {
        waiter.resolve()
      }
    }
    if (pending.length > 0) {
      this.waitersByPty.set(ptyId, pending)
    } else {
      this.waitersByPty.delete(ptyId)
    }
  }

  closeGeneration(providerGeneration: number): void {
    for (const [ptyId, waiters] of this.waitersByPty) {
      const pending = waiters.filter((waiter) => waiter.providerGeneration !== providerGeneration)
      for (const waiter of waiters) {
        if (waiter.providerGeneration === providerGeneration) {
          waiter.resolve()
        }
      }
      if (pending.length > 0) {
        this.waitersByPty.set(ptyId, pending)
      } else {
        this.waitersByPty.delete(ptyId)
      }
    }
  }
}
