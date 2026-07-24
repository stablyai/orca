import { isPtyIncarnationId, type PtyIncarnationId } from '../../shared/pty-incarnation'

type PendingSshPtySpawn = {
  exits: { relayPtyId: string; incarnationId?: PtyIncarnationId }[]
}

export class SshPtySpawnExitRaceTracker {
  private pending = new Set<PendingSshPtySpawn>()

  begin(): PendingSshPtySpawn {
    const operation = { exits: [] }
    this.pending.add(operation)
    return operation
  }

  recordExit(relayPtyId: string, incarnationId: unknown): void {
    for (const operation of this.pending) {
      operation.exits.push({
        relayPtyId,
        ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {})
      })
    }
  }

  didMatchingExitArrive(
    operation: PendingSshPtySpawn,
    result: { id: string; incarnationId?: PtyIncarnationId }
  ): boolean {
    return operation.exits.some(
      (exit) =>
        exit.relayPtyId === result.id &&
        (!exit.incarnationId ||
          !result.incarnationId ||
          exit.incarnationId === result.incarnationId)
    )
  }

  finish(operation: PendingSshPtySpawn): void {
    this.pending.delete(operation)
  }
}
